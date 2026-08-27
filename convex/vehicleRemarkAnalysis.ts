import { v } from "convex/values";
import { env, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireCrmPermission } from "./lib";

const FLEET_PAGE_KEY = "mesoutils:gotravaux";

const priority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));

type RemarkSnapshot = {
  vehicle: {
    name: string;
    plate?: string;
    brand?: string;
    model?: string;
    year?: number;
    kind?: "utilitaire" | "voiture";
    odometerKm?: number;
  };
  remarks: Array<{
    submittedAt: number;
    userName: string;
    purpose: string;
    mileage?: number;
    fuelRestored?: boolean;
    vehicleEmpty?: boolean;
    vehicleClean?: boolean;
    issues?: string;
    notes?: string;
  }>;
  /** Interventions clôturées : contexte pour éviter de proposer un travail déjà effectué. */
  completedTasks: Array<{
    title: string;
    description?: string;
    performedAt?: number;
    odometerKm?: number;
    laborMinutes?: number;
    partsCost?: number;
  }>;
  latestFeedbackAt?: number;
};

/**
 * Radicaux techniques déclenchant l'analyse.
 *
 * Pas de `\b` final : ce sont des RADICAUX, pas des mots entiers. Avec la borne
 * de fin, « Revoir les freins » ne déclenchait rien (le `s` de « freins » cassait
 * la limite de mot) alors que « frein » au singulier passait — d'où des
 * véhicules absents de l'analyse malgré une remarque explicite.
 */
const MECHANICAL_REMARK_PATTERN = /\b(m[eé]can|bruit|vibrat|roulement|pneu|crevaison|frein|direction|suspension|amortiss|rotule|biellette|triangle|cardan|embrayage|bo[iî]te|moteur|batterie|alternateur|d[eé]marr|voyant|phare|clignot|[eé]clairage|essuie|ventilat|chauffage|clim|d[eé]sembu|fum[eé]e|fuite|huile|liquide|radiateur|temp[eé]rature|surchauff|[eé]lectr|panne|ne fonctionne|ne marche|d[eé]faill|s[eé]curit[eé]|ceinture|airbag|pare-brise|chasse|patine|broute|cogne|claque|grince|siffl|tire [aà] |embray|jeu dans)/i;

function hasMechanicalRemark(issues?: string, notes?: string) {
  return MECHANICAL_REMARK_PATTERN.test(`${issues ?? ""}\n${notes ?? ""}`);
}

function fallbackAnalysis(snapshot: RemarkSnapshot) {
  const reported = snapshot.remarks
    .map((remark) => [remark.issues, remark.notes].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 420);
  const context = reported || "Anomalie technique signalée dans un retour véhicule.";
  return {
    summary: `Signalement technique à contrôler : ${context}`.slice(0, 280),
    diagnosis: `**Constat**\n${context}\n\n**Pistes à vérifier**\n- Reproduire le symptôme et isoler l'organe concerné.\n\n**Contrôles prioritaires**\n- Contrôle atelier ciblé selon le symptôme signalé.`.slice(0, 900),
  };
}

const ANALYST_INSTRUCTIONS = [
  "Tu es Mécania, mécanicienne automobile senior spécialisée dans le diagnostic de véhicules utilitaires et voitures de flotte.",
  "Tu analyses les retours d'utilisation d'UN SEUL véhicule et tu aides une équipe non technique à décider des prochaines maintenances.",
  "L'historique `completedTasks` liste les interventions déjà réalisées sur ce véhicule. Utilise-le comme contexte : rapproche les retours d'une réparation récente, signale une récidive si elle est cohérente, et ne propose jamais une intervention déjà effectuée sauf si les nouveaux symptômes justifient explicitement un nouveau contrôle.",
  "Réponds uniquement en français et en JSON valide, sans markdown.",
  "Tu as accès à une recherche web : utilise-la systématiquement lorsque la marque et le modèle sont renseignés, afin de rechercher les défauts récurrents et les recommandations techniques correspondant au véhicule, à son année et aux symptômes signalés.",
  "N'utilise les informations trouvées sur le web que si elles concernent bien la marque, le modèle, la génération et, si connue, l'année du véhicule. Une information générale ou concernant une autre motorisation ne suffit pas.",
  "RIGUEUR DES SOURCES : n'ajoute une source que si sa page explique réellement le symptôme ou le contrôle concerné ET mentionne explicitement le modèle exact et l'année demandée, ou une plage de millésimes incluant cette année. Écarte toute source d'un autre millésime, d'une autre génération, d'une autre motorisation non confirmée, ainsi que les pages d'accueil, FAQ, sommaires, résultats de recherche et pages de navigation. En cas de doute, ne mets aucune source.",
  "Privilégie les manuels constructeur, rappels, bulletins techniques et sources d'atelier reconnues. Un forum peut suggérer une piste, mais ne doit jamais être présenté comme une preuve ni être retenu comme source si une source technique plus fiable existe.",
  "Les problèmes connus issus du web restent des pistes à vérifier : ne les présente jamais comme une panne avérée et ne propose pas une maintenance uniquement sur la base d'un problème connu sans symptôme cohérent dans les retours.",
  "Ne conserve dans sources que 2 liens techniques directement utiles, avec leur titre et leur URL complète. Si aucune source pertinente n'a été trouvée, renvoie un tableau vide.",
  "Ne prétends jamais qu'une panne est certaine : distingue les faits signalés et les vérifications recommandées.",
  "L'avis s'adresse à un mécanicien expérimenté : sois direct, précis et très concis. Donne seulement les pistes utiles, sans expliquer les évidences ni reformuler tous les retours.",
  "PÉRIMÈTRE STRICT : ne traite que les anomalies mécaniques, électriques, électroniques, de freinage, de direction, de suspension, de pneus, d'éclairage, de ventilation, de chauffage, de climatisation ou de sécurité qui dégradent le fonctionnement du véhicule.",
  "EXCLUS SANS EXCEPTION : carburant ou plein non fait, propreté, vitres sales, objets laissés, rangement, carnet de bord, kilométrage non renseigné, marquage, flocage, organisation, réservations, système audio/de confort non essentiel et tout sujet administratif ou de gestion. Ne les résume pas et ne propose jamais de maintenance pour eux.",
  "Ne crée une proposition que si elle est justifiée par une anomalie technique ou de sécurité réellement signalée dans les retours.",
  "Au maximum 3 propositions, concrètes et actionnables. Chaque titre fait au plus 90 caractères et chaque description au plus 220 caractères. Une priorité vaut low, medium ou high.",
  "S'il n'y a aucune anomalie technique ou de sécurité à retenir, réponds avec une synthèse vide et aucune proposition. N'écris pas de message du type « tout va bien ».",
  "La valeur summary fait au plus 280 caractères. La valeur diagnosis fait au plus 900 caractères et respecte exactement cette présentation : **Constat** puis une phrase, **Pistes à vérifier** puis au plus 3 puces, **Contrôles prioritaires** puis au plus 3 puces. Chaque section est sur sa propre ligne. Utilise le gras uniquement pour ces titres, sans paragraphe compact ni conclusion de prudence.",
  'Format strict : {"summary":"... ou vide","diagnosis":"**Constat**\\n...\\n\\n**Pistes à vérifier**\\n- ...\\n\\n**Contrôles prioritaires**\\n- ... ou vide","webSources":[{"title":"...","url":"https://...","yearScope":"année ou plage de millésimes explicitement citée"}],"proposals":[{"title":"...","description":"...","priority":"low|medium|high"}]}',
].join("\n");

/** Données métiers bornées, accessibles uniquement à l'action IA interne. */
export const snapshot = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, { vehicleId }): Promise<RemarkSnapshot | null> => {
    const vehicle = await ctx.db.get(vehicleId);
    if (!vehicle) return null;
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
      .order("desc")
      .take(100);
    const maintenanceTasks = await ctx.db
      .query("vehicleMaintenanceTasks")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
      .order("desc")
      .take(100);
    const feedbackReservations = reservations
      .filter((reservation) => reservation.feedbackSubmittedAt)
      .sort((a, b) => (b.feedbackSubmittedAt ?? 0) - (a.feedbackSubmittedAt ?? 0))
    const remarks = feedbackReservations
      // Mécania ne travaille que sur les retours ayant déclaré un incident. Les
      // retours anciens n'ont pas le drapeau : un texte d'incident en tient lieu.
      .filter((reservation) =>
        reservation.feedbackIncident ?? Boolean(reservation.feedbackIssues?.trim()),
      )
      .filter((reservation) => hasMechanicalRemark(reservation.feedbackIssues, reservation.feedbackNotes))
      .map((reservation) => ({
        submittedAt: reservation.feedbackSubmittedAt ?? reservation._creationTime,
        userName: reservation.userName,
        purpose: reservation.purpose,
        mileage: reservation.feedbackMileage,
        fuelRestored: reservation.feedbackFuelRestored,
        vehicleEmpty: reservation.feedbackVehicleEmpty,
        vehicleClean: reservation.feedbackVehicleClean,
        issues: reservation.feedbackIssues,
        notes: reservation.feedbackNotes,
      }));
    const completedTasks = maintenanceTasks
      .filter((task) => task.status === "done")
      .map((task) => ({
        title: task.title,
        description: task.description,
        // Une tâche clôturée renseigne `dueDate` comme date d'intervention ;
        // on garde `updatedAt` comme repli pour les historiques plus anciens.
        performedAt: task.dueDate ?? task.updatedAt,
        odometerKm: task.odometerKm,
        laborMinutes: task.laborMinutes,
        partsCost: task.partsCost,
      }));
    return {
      vehicle: {
        name: vehicle.name,
        plate: vehicle.plate,
        brand: vehicle.brand,
        model: vehicle.model,
        year: vehicle.year,
        kind: vehicle.kind,
        odometerKm: vehicle.odometerKm,
      },
      remarks,
      completedTasks,
      latestFeedbackAt: feedbackReservations[0]?.feedbackSubmittedAt,
    };
  },
});

/** Enregistre une analyse seulement si elle couvre au moins les derniers retours connus. */
export const save = internalMutation({
  args: {
    vehicleId: v.id("vehicles"),
    summary: v.string(),
    diagnosis: v.optional(v.string()),
    webSources: v.array(v.object({ title: v.string(), url: v.string() })),
    proposals: v.array(v.object({ title: v.string(), description: v.string(), priority })),
    sourceRemarkCount: v.number(),
    latestRemarkAt: v.number(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicleRemarkAnalyses")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", args.vehicleId))
      .unique();
    // `latestRemarkAt` représente désormais le dernier retour *mécanique*.
    // Une ancienne analyse pouvait mémoriser un retour de gestion plus récent ;
    // ne bloquons donc jamais sa remise à jour par la nouvelle synthèse filtrée.
    const payload = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
    } else {
      await ctx.db.insert("vehicleRemarkAnalyses", payload);
    }
  },
});

/** Retire une ancienne analyse lorsque les retours ne remontent aucun sujet technique. */
export const clear = internalMutation({
  args: { vehicleId: v.id("vehicles"), latestRemarkAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicleRemarkAnalyses")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", args.vehicleId))
      .unique();
    if (existing && existing.latestRemarkAt <= args.latestRemarkAt) await ctx.db.delete(existing._id);
  },
});

/** Lance OpenAI après chaque retour véhicule ; la synthèse inclut tous ses retours. */
export const analyze = internalAction({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, { vehicleId }) => {
    const snapshot: RemarkSnapshot | null = await ctx.runQuery(internal.vehicleRemarkAnalysis.snapshot, { vehicleId });
    if (!snapshot) return null;
    if (snapshot.remarks.length === 0) {
      if (snapshot.latestFeedbackAt) {
        await ctx.runMutation(internal.vehicleRemarkAnalysis.clear, {
          vehicleId,
          latestRemarkAt: snapshot.latestFeedbackAt,
        });
      }
      return null;
    }
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Clé OpenAI non configurée pour l'analyse des retours véhicules.");

    const model = env.OPENAI_REQUEST_ANALYSIS_MODEL?.trim() || "gpt-4o";
    try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: ANALYST_INSTRUCTIONS,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        max_output_tokens: 1_500,
        input: JSON.stringify(snapshot),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI n'a pas pu analyser les retours (${response.status}).`);
    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const raw = data.output_text ?? data.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text ?? "";
    let parsed: { summary?: unknown; diagnosis?: unknown; webSources?: unknown; proposals?: unknown };
    try {
      let json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      if (!json.startsWith("{")) {
        const first = json.indexOf("{");
        const last = json.lastIndexOf("}");
        if (first >= 0 && last > first) json = json.slice(first, last + 1);
      }
      parsed = JSON.parse(json) as { summary?: unknown; diagnosis?: unknown; webSources?: unknown; proposals?: unknown };
    } catch {
      throw new Error("OpenAI a renvoyé une analyse illisible.");
    }
    const priorityValues = new Set(["low", "medium", "high"]);
    const proposals = Array.isArray(parsed.proposals)
      ? parsed.proposals.slice(0, 3).flatMap((proposal) => {
          if (!proposal || typeof proposal !== "object") return [];
          const value = proposal as { title?: unknown; description?: unknown; priority?: unknown };
          const title = typeof value.title === "string" ? value.title.trim().slice(0, 90) : "";
          const description = typeof value.description === "string" ? value.description.trim().slice(0, 220) : "";
          if (!title || !description) return [];
          return [{ title, description, priority: priorityValues.has(value.priority as string) ? value.priority as "low" | "medium" | "high" : "medium" }];
        })
      : [];
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 280) : "";
    const diagnosis = typeof parsed.diagnosis === "string" ? parsed.diagnosis.trim().slice(0, 900) : "";
    const webSources = Array.isArray(parsed.webSources)
      ? parsed.webSources.slice(0, 2).flatMap((source) => {
          if (!source || typeof source !== "object") return [];
          const value = source as { title?: unknown; url?: unknown; yearScope?: unknown };
          const title = typeof value.title === "string" ? value.title.trim().slice(0, 180) : "";
          const url = typeof value.url === "string" ? value.url.trim().slice(0, 1000) : "";
          const yearScope = typeof value.yearScope === "string" ? value.yearScope : "";
          const isGenericPage = /\b(faq|accueil|home|contenu du site|choix des documents|service box)\b/i.test(title);
          const hasExactYear = !snapshot.vehicle.year || new RegExp(`\\b${snapshot.vehicle.year}\\b`).test(yearScope);
          if (!title || isGenericPage || !hasExactYear || !/^https?:\/\//i.test(url)) return [];
          return [{ title, url }];
        })
      : [];
    if (!summary && proposals.length === 0) {
      await ctx.runMutation(internal.vehicleRemarkAnalysis.clear, {
        vehicleId,
        latestRemarkAt: snapshot.remarks[0].submittedAt,
      });
      return null;
    }
    if (!summary) throw new Error("OpenAI n'a pas fourni de synthèse exploitable.");
    await ctx.runMutation(internal.vehicleRemarkAnalysis.save, {
      vehicleId,
      summary,
      diagnosis: diagnosis || undefined,
      webSources,
      proposals,
      sourceRemarkCount: snapshot.remarks.length,
      latestRemarkAt: snapshot.remarks[0].submittedAt,
      model,
    });
    return null;
    } catch (error) {
      // Une indisponibilité ponctuelle de la recherche web ne doit pas conserver
      // une ancienne analyse trop longue ou devenue hors sujet.
      const fallback = fallbackAnalysis(snapshot);
      await ctx.runMutation(internal.vehicleRemarkAnalysis.save, {
        vehicleId,
        summary: fallback.summary,
        diagnosis: fallback.diagnosis,
        webSources: [],
        proposals: [],
        sourceRemarkCount: snapshot.remarks.length,
        latestRemarkAt: snapshot.remarks[0].submittedAt,
        model: `${model} (secours)`,
      });
      console.warn("Analyse IA véhicule remplacée par un résumé de secours.", error);
      return null;
    }
  },
});

/** Relance explicitement les analyses existantes ; réservé aux gestionnaires flotte. */
export const rerunExisting = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "manage");
    const reservations = await ctx.db.query("vehicleReservations").order("desc").take(300);
    const vehicleIds = Array.from(
      new Set(
        reservations
          .filter((reservation) => reservation.feedbackSubmittedAt)
          .map((reservation) => reservation.vehicleId),
      ),
    );
    for (const [index, vehicleId] of vehicleIds.entries()) {
      // Les analyses avec recherche web sont volontairement espacées pour éviter
      // les réponses dégradées ou limitées lorsque tout l'historique est relancé.
      await ctx.scheduler.runAfter(index * 5_000, internal.vehicleRemarkAnalysis.analyze, { vehicleId });
    }
    return { scheduled: vehicleIds.length };
  },
});

/** Synthèse affichée au-dessus des retours, globalement ou pour un véhicule précis. */
export const list = query({
  args: { vehicleId: v.optional(v.id("vehicles")) },
  handler: async (ctx, { vehicleId }) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "read");
    if (vehicleId) {
      const analysis = await ctx.db
        .query("vehicleRemarkAnalyses")
        .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
        .unique();
      const vehicle = await ctx.db.get(vehicleId);
      return analysis ? [{
        ...analysis,
        vehicleName: vehicle?.name ?? "Véhicule",
        vehiclePhotoUrl: vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl ?? null,
      }] : [];
    }
    const analyses = await ctx.db.query("vehicleRemarkAnalyses").order("desc").take(100);
    return await Promise.all(
      analyses.map(async (analysis) => {
        const vehicle = await ctx.db.get(analysis.vehicleId);
        return {
          ...analysis,
          vehicleName: vehicle?.name ?? "Véhicule",
          vehiclePhotoUrl: vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl ?? null,
        };
      }),
    );
  },
});
