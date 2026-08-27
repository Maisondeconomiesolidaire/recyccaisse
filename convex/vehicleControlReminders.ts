import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { esc, resendSend } from "./emails";

/** Destinataires des rappels de contrôles véhicules. */
const RECIPIENTS = [
  "f.henry@eco-solidaire.fr",
  "b.ryckeboer@eco-solidaire.fr",
  "y.prata@eco-solidaire.fr",
  "s.lahmer@eco-solidaire.fr",
];

/** Jours avant l'échéance qui déclenchent un rappel (1 = « c'est demain »). */
const THRESHOLDS = [30, 15, 5, 1];

const FROM = "Mes Outils <no-reply@mesoutils.eco-solidaire.fr>";

export const listVehicleControls = internalQuery({
  args: {},
  handler: async (ctx) => {
    const vehicles = await ctx.db.query("vehicles").collect();
    return vehicles
      .filter((vehicle) => vehicle.active)
      .map((vehicle) => ({
        name: vehicle.name,
        plate: vehicle.plate ?? null,
        technicalControlDate: vehicle.technicalControlDate ?? null,
        pollutionControlDate: vehicle.pollutionControlDate ?? null,
      }));
  },
});

/** Date du jour (YYYY-MM-DD) en heure de Paris. */
function parisToday(): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

/** Nombre de jours entre aujourd'hui et une date `YYYY-MM-DD` (négatif si passée). */
function daysUntil(dateStr: string, today: string): number | null {
  const target = Date.parse(dateStr);
  const now = Date.parse(today);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return null;
  return Math.round((target - now) / 86_400_000);
}

function formatDateFr(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

type ControlEvent = {
  vehicleName: string;
  plate: string | null;
  controlLabel: string;
  date: string;
  days: number;
};

function buildEmail(event: ControlEvent): { subject: string; html: string } {
  const vehicleLabel = `${event.vehicleName}${event.plate ? ` (${event.plate})` : ""}`;
  const when =
    event.days === 1 ? "c'est demain !" : `dans ${event.days} jours`;
  const subject = `⏰ ${event.controlLabel} — ${vehicleLabel} : ${when}`;
  const urgency = event.days === 1 ? "#dc2626" : event.days <= 5 ? "#d97706" : "#166534";
  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8e4;">
      <tr><td style="background:#1b3325;padding:18px 26px;">
        <p style="margin:0;color:#ffffff;font-size:16px;font-weight:bold;">Mes Outils — Flotte véhicules</p>
      </td></tr>
      <tr><td style="padding:26px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${urgency};">
          ${event.days === 1 ? "Échéance demain" : `Échéance dans ${event.days} jours`}
        </p>
        <p style="margin:0 0 14px;font-size:19px;font-weight:bold;color:#152019;">
          ${esc(event.controlLabel)} — ${esc(vehicleLabel)}
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#3d4a46;">
          Le <strong>${esc(event.controlLabel.toLowerCase())}</strong> du véhicule
          <strong>${esc(vehicleLabel)}</strong> arrive à échéance le
          <strong>${esc(formatDateFr(event.date))}</strong>${event.days === 1 ? " — <strong>c'est demain</strong>." : "."}
        </p>
        <p style="margin:0;font-size:13px;line-height:20px;color:#6b7a72;">
          Pensez à prendre rendez-vous et à mettre à jour la date dans la fiche du véhicule
          (Mes Outils → Gotravaux → Flotte) une fois le contrôle effectué.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html };
}

/**
 * Cron quotidien : rappels de contrôle technique / contrôle pollution à
 * J-30, J-15, J-5 et J-1 (« c'est demain ») aux responsables flotte.
 */
export const sendControlReminders = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const vehicles: Array<{
      name: string;
      plate: string | null;
      technicalControlDate: string | null;
      pollutionControlDate: string | null;
    }> = await ctx.runQuery(internal.vehicleControlReminders.listVehicleControls, {});

    const today = parisToday();
    const events: ControlEvent[] = [];
    for (const vehicle of vehicles) {
      const controls: Array<[string, string | null]> = [
        ["Contrôle technique", vehicle.technicalControlDate],
        ["Contrôle technique pollution", vehicle.pollutionControlDate],
      ];
      for (const [controlLabel, date] of controls) {
        if (!date) continue;
        const days = daysUntil(date, today);
        if (days !== null && THRESHOLDS.includes(days)) {
          events.push({ vehicleName: vehicle.name, plate: vehicle.plate, controlLabel, date, days });
        }
      }
    }

    // Envois séquentiels espacés (limite Resend : 2 requêtes/seconde).
    let sent = 0;
    for (const event of events) {
      const { subject, html } = buildEmail(event);
      await resendSend(RECIPIENTS, subject, html, FROM);
      sent += 1;
      if (sent < events.length) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    return { sent };
  },
});
