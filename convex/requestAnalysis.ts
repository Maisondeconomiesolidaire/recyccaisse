import { v } from "convex/values";
import { action, env, query } from "./_generated/server";
import { api } from "./_generated/api";
import { requireCrmPermission } from "./lib";

type SnapshotRequest = {
  id: string;
  reference: string;
  type: string;
  collecteType: string | null;
  stage: string;
  displayedStage: string;
  outcome: string;
  complete: boolean;
  scheduledDate: number | null;
  assignedTo: string | null;
  assignedName: string | null;
  site: string | null;
  city: string | null;
  postalCode: string | null;
  customerName: string;
  createdAt: number;
  updatedAt: number;
};

type AnalysisSnapshot = {
  generatedAt: number;
  requests: SnapshotRequest[];
  team: Array<{ id: string; name: string }>;
};

const TYPE_LABELS: Record<string, string> = {
  aerogommage: "Aérogommage",
  collecte: "Collecte",
  article: "Boutique",
  velo: "Cycle en Bray",
  livraison: "Livraison",
};

function displayedStage(request: {
  completedSteps: number;
  processSteps: string[];
}) {
  if (request.completedSteps <= 0) return "Nouveau";
  const doneStep = request.processSteps[Math.min(request.completedSteps, request.processSteps.length) - 1];
  return doneStep ?? "Nouveau";
}

function compactSnapshot(snapshotData: AnalysisSnapshot): AnalysisSnapshot {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const requests = snapshotData.requests
    .filter((request) => request.outcome === "open" || request.updatedAt >= ninetyDaysAgo)
    .sort((a, b) => {
      const aScore = (a.outcome === "open" ? 1_000_000_000_000 : 0) + a.updatedAt;
      const bScore = (b.outcome === "open" ? 1_000_000_000_000 : 0) + b.updatedAt;
      return bScore - aScore;
    })
    .slice(0, 120);
  return {
    generatedAt: snapshotData.generatedAt,
    team: snapshotData.team,
    requests,
  };
}

export const snapshot = query({
  args: {},
  handler: async (ctx): Promise<AnalysisSnapshot> => {
    await requireCrmPermission(ctx, "demandes", "read");
    const [requests, team] = await Promise.all([
      ctx.db.query("requests").order("desc").collect(),
      ctx.db.query("polyvalentWorkers").take(500),
    ]);
    const teamNames = new Map(
      team.map((worker) => [String(worker._id), `${worker.firstName} ${worker.lastName}`.trim()]),
    );

    return {
      generatedAt: Date.now(),
      team: team.map((worker) => ({
        id: String(worker._id),
        name: teamNames.get(String(worker._id)) ?? "",
      })),
      requests: requests.map((request) => ({
        id: String(request._id),
        reference: request.reference ?? String(request._id).slice(-6),
        type: TYPE_LABELS[request.type] ?? request.type,
        collecteType: request.collecteType ?? null,
        stage: request.stage,
        displayedStage: displayedStage(request),
        outcome: request.outcome,
        complete: request.complete,
        scheduledDate: request.scheduledDate ?? null,
        assignedTo: request.assignedWorkerId ? String(request.assignedWorkerId) : null,
        assignedName: request.assignedWorkerId ? teamNames.get(String(request.assignedWorkerId)) ?? null : null,
        site: request.site ?? null,
        city: request.customer.city ?? null,
        postalCode: request.customer.postalCode ?? null,
        customerName: [request.customer.firstName, request.customer.lastName]
          .filter(Boolean)
          .join(" ")
          .trim(),
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      })),
    };
  },
});

const OUTCOME_LABELS: Record<string, string> = {
  open: "En cours",
  gagnee: "Terminée",
  perdue: "Annulée",
};

/** Date ISO courte (AAAA-MM-JJ), lisible et non ambiguë pour le modèle. */
function isoDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Convertit le snapshot technique en données métier en français (aucune clé ou valeur technique). */
function humanizeSnapshot(snapshotData: AnalysisSnapshot) {
  return {
    genere_le: isoDay(snapshotData.generatedAt),
    encadrants: snapshotData.team.map((member) => member.name),
    demandes: snapshotData.requests.map((request) => ({
      reference: `#${request.reference}`,
      type: request.type,
      ...(request.collecteType ? { type_collecte: request.collecteType } : {}),
      etape: request.displayedStage,
      statut: OUTCOME_LABELS[request.outcome] ?? request.outcome,
      traitement: request.complete ? "Traitée" : "À traiter",
      planifiee_le: request.scheduledDate ? isoDay(request.scheduledDate) : "Non planifiée",
      encadrant: request.assignedName ?? "Non assigné",
      ville: request.city ?? "—",
      code_postal: request.postalCode ?? "—",
      client: request.customerName,
      creee_le: isoDay(request.createdAt),
    })),
  };
}

/** Nettoie la réponse : retire les symboles de mise en forme non gérés (backticks, astérisques parasites). */
function sanitizeAnswer(text: string) {
  return text
    .replace(/`+/g, "") // pas de code inline
    .replace(/\*{3,}/g, "**") // *** -> **
    .replace(/(^|\n)\s*\*\s+/g, "$1- ") // puces "* " -> "- "
    .replace(/(^|[^*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, "$1$2") // *italique* -> texte simple
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const SYSTEM_PROMPT = [
  "Tu es l'assistant manager CRM de Recycapp (recyclerie). Tu aides à organiser collectes, planning, encadrants et priorités à partir des demandes.",
  "",
  "LANGAGE :",
  "- Réponds en français courant, clair et opérationnel, comme à un responsable d'équipe.",
  "- N'emploie JAMAIS de termes informatiques, de noms de champs ou d'expressions techniques (par ex. n'écris jamais « complete = false », « outcome », « stage », « request.x », « true/false », « null »). Dis plutôt « à planifier », « non assignée », « terminée », « en cours »…",
  "- Ne décris jamais la structure des données ni le JSON reçu.",
  "",
  "MISE EN FORME (à respecter strictement) :",
  "- Titres de section : une courte ligne entièrement en **gras** (doubles astérisques).",
  "- Listes : une puce par ligne commençant par « - ».",
  "- Pour mettre un mot en valeur : **gras** uniquement.",
  "- N'utilise AUCUN autre symbole : pas de tableaux, pas de titres Markdown avec #, pas d'astérisque simple, pas de triple astérisque, pas de backticks, pas d'émojis.",
  "",
  "CONTENU :",
  "- Va à l'essentiel, sections courtes et actions concrètes.",
  "- Quand tu cites une demande, utilise sa référence au format #000123.",
  "- Limite la première réponse à 450 mots maximum.",
  "- Ne prétends jamais avoir modifié les données : tu analyses et proposes seulement.",
].join("\n");

export const chat = action({
  args: {
    messages: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, { messages }) => {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Clé OpenAI non configurée. Ajoutez OPENAI_API_KEY dans les variables Convex.");
    }

    const snapshotData = compactSnapshot(await ctx.runQuery(api.requestAnalysis.snapshot, {}));
    const compactMessages = messages.slice(-10);

    const chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Voici les demandes du CRM (données métier, dates au format AAAA-MM-JJ). Priorise : demandes à planifier, journées chargées, regroupements par ville/date/type, assignations d'encadrants, risques et prochaines actions.\n\n" +
          JSON.stringify(humanizeSnapshot(snapshotData)),
      },
      ...compactMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    // On respecte le modèle configuré (OPENAI_REQUEST_ANALYSIS_MODEL) mais on
    // bascule automatiquement sur gpt-4o si ce modèle est indisponible/invalide,
    // pour que l'assistant reste fonctionnel quel que soit l'état du compte.
    const preferred = env.OPENAI_REQUEST_ANALYSIS_MODEL?.trim();
    const candidates = Array.from(new Set([preferred, "gpt-4o"].filter(Boolean))) as string[];

    let answer = "";
    let usedModel = "";
    let lastError = "";
    for (const model of candidates) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: chatMessages,
          temperature: 0.2,
          max_tokens: 1200,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        answer = sanitizeAnswer(data.choices?.[0]?.message?.content ?? "");
        usedModel = model;
        break;
      }
      lastError = `(${response.status}) ${(await response.text()).slice(0, 200)}`;
    }

    if (!answer) {
      throw new Error(
        `L'assistant IA n'a pas pu répondre. Dernière erreur OpenAI : ${lastError || "réponse vide"}`,
      );
    }

    return {
      answer,
      model: usedModel,
      requestRefs: snapshotData.requests.map((request) => ({
        id: request.id,
        reference: request.reference,
        label: `${request.type} #${request.reference}`,
      })),
    };
  },
});
