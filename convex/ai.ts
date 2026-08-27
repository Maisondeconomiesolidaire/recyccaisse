import { action, mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { accessAllows, requireCrmPermission } from "./lib";

const CATEGORIES = {
  "Maison et Jardin": [
    "Ameublement",
    "Électroménager",
    "Décoration",
    "Bricolage",
    "Vaisselle",
  ],
  Électronique: [
    "Ordinateurs",
    "Téléphones",
    "Tablettes",
    "Photo, audio et vidéo",
    "Accessoires informatique",
  ],
  Loisirs: [
    "Jeux et Jouets",
    "Vélos",
    "CD - Musique",
    "DVD - Films",
    "Instruments de musique",
    "Livres",
  ],
};

const CONDITIONS = ["Neuf", "Très bon état", "Bon état", "État correct", "À rénover"];

/**
 * Modèle OpenAI utilisé par le module.
 *
 * `gpt-4o-search-preview`, qui portait la recherche de prix, a été retiré par
 * OpenAI (404 `model_not_found`). Son remplaçant en Chat Completions,
 * `gpt-5-search-api`, est plafonné à 6 000 jetons par minute sur ce compte :
 * un run de quelques articles le sature immédiatement. On passe donc par
 * l'API Responses et l'outil `web_search`, qui consomme les quotas (bien plus
 * larges) du modèle principal.
 *
 * Coût mesuré sur ce pipeline (identification visuelle d'une photo du stock +
 * valorisation avec recherche web), par article :
 *
 *   gpt-5.5        ~0,23 €    prix 3,50 €
 *   gpt-5.4        ~0,081 €   prix 3,50–4,50 €
 *   gpt-5.4-mini   ~0,027 €   prix 7–14 €
 *   gpt-5.4-nano   ~0,015 €   prix 4–13 €, justification d'état parfois vide
 *
 * `gpt-5.4-mini` est le choix retenu : trois fois moins cher que 5.4, et sa
 * lecture des photos reste solide (même état constaté, justification détaillée).
 *
 * ⚠️ Il applique en revanche moins strictement les décotes du prompt et
 * surévalue d'un facteur ~2 sur les petits articles. Si trop de stock reste
 * invendu, la première chose à faire est de repasser cette constante à
 * `gpt-5.4` — le reste du code est identique.
 */
const MODEL = "gpt-5.4-mini";

// ─── Step 1: vision identification prompt ─────────────────────────────────────
const IDENTIFICATION_PROMPT = `Tu es un inspecteur d'articles de seconde main réputé pour son regard critique et honnête. Tu ne flattes jamais l'état d'un article.

RÈGLES D'ÉTAT — applique-les strictement en regardant CHAQUE détail visible :
- "Neuf" : emballage d'origine intact ou article manifestement jamais utilisé. RARISSIME en recyclerie.
- "Très bon état" : usage léger à peine perceptible, AUCUNE rayure, tache, décoloration ou pièce manquante visible. Réserve cette note aux vrais articles impeccables.
- "Bon état" : usure normale visible (petites rayures, légère décoloration, traces de manipulation). C'est l'état PAR DÉFAUT d'un article d'occasion utilisé.
- "État correct" : défauts clairement visibles (rayures marquées, taches, fissures mineures, pièces abîmées mais fonctionnelles). Donne cette note si TU DOUTES entre bon état et état correct.
- "À rénover" : réparations nécessaires, pièces manquantes, casse visible, inutilisable en l'état.

BIAIS À CORRIGER :
- Un jouet utilisé par un enfant est au MINIMUM "Bon état", souvent "État correct"
- Un vélo d'enfant avec de la terre/poussière visible = "Bon état" ou "État correct"
- Des meubles avec des traces de vie = "Bon état" au mieux
- Si tu vois de la saleté, des rayures ou de l'usure sur la photo → descends d'un cran
- En cas de doute → choisis l'état INFÉRIEUR, jamais supérieur

IDENTIFICATION FINE — l'étape suivante fera des recherches web, la qualité du résultat dépend ENTIÈREMENT de ta précision ici :
- Lis TOUT le texte visible sur la photo : marque, modèle, référence, numéro de série, étiquette, plaque signalétique, logo, mention au dos ou sous l'objet.
- Cherche le modèle EXACT, pas la famille ("Moulinex Masterchef Gourmet QA503", pas "robot pâtissier"). Si tu hésites entre deux modèles proches, donne les deux dans "modelHypotheses".
- Note les indices datant l'objet (design, logo d'époque, type de connectique, matériaux).
- Pour les objets sous licence (jouets, jeux, figurines) : identifie la licence, le personnage ET la référence de série si visible.

Analyse cette image et retourne UNIQUEMENT un JSON valide (sans markdown) :
{
  "name": "nom précis de l'objet en français (marque, modèle et référence si visibles, matière, couleur, style)",
  "brand": "marque si identifiable, sinon null",
  "model": "modèle / référence exacte si lisible ou déductible, sinon null",
  "modelHypotheses": ["1 à 3 modèles ou références plausibles si le modèle exact n'est pas certain"],
  "visibleText": "tout le texte lisible sur la photo (étiquettes, plaques, sérigraphies), sinon null",
  "estimatedCondition": "une de : Neuf | Très bon état | Bon état | État correct | À rénover",
  "conditionJustification": "liste des défauts visibles qui justifient cette note (sois précis et honnête)",
  "searchQueries": [
    "requête 1 : marque + modèle exact + occasion (pour leboncoin)",
    "requête 2 : marque + modèle + prix vendu (vinted / ebay)",
    "requête 3 : marque + modèle + prix neuf (amazon / site officiel)",
    "requête 4 : requête de repli plus large si le modèle exact est incertain",
    "requête 5 : requête sur la référence, le numéro de série ou la licence/personnage"
  ],
  "keyDetails": "détails clés : dimensions estimées, matière, particularités, TOUS les défauts visibles",
  "backgroundPrompt": "In English: a concise product photography background description (max 50 words) for this item. Focus on setting, surfaces, and lighting only — no people, no figures. Match the product's material and style. Example for a wooden chair: 'Warm Scandinavian studio, pale linen backdrop, wood grain floor, soft diffused natural light'. Example for a toy: 'Clean white studio, smooth seamless floor, bright even lighting'. Keep it factual and environment-focused."
}`;

// ─── Step 2: valuation prompt (receives search results) ───────────────────────
const VALUATION_PROMPT = `Tu es un acheteur-revendeur professionnel d'occasion, connu pour être EXIGEANT et réaliste. Tu travailles pour Cycle en Bray, une recyclerie dans l'Oise. Tu n'es pas là pour faire plaisir au donateur — tu es là pour fixer un prix juste qui se vendra vraiment.

On te donne :
- La description et l'état d'un article identifié par analyse visuelle (avec justification de l'état)
- Des résultats de recherche en temps réel sur Leboncoin, eBay France, Vinted et Amazon France

MÉTHODE DE RECHERCHE WEB (approfondie — ne te contente JAMAIS d'une seule requête) :
1. Commence par IDENTIFIER précisément l'article avant de le valoriser : cherche la marque + le modèle/référence pour confirmer de quel produit il s'agit exactement (fiche produit constructeur, notice, test, fiche Amazon/Fnac/Darty). Si l'identification visuelle proposait plusieurs hypothèses de modèle, tranche avec la recherche.
2. Fais AU MOINS 4 recherches distinctes, et enchaîne-les en affinant :
   - une sur les annonces d'occasion (leboncoin),
   - une sur les ventes réalisées (vinted, ebay France — privilégie les articles VENDUS, pas les prix demandés),
   - une sur le prix neuf actuel ou dernier prix catalogue (Amazon, site de la marque, Fnac/Darty/Cdiscount),
   - une sur l'identification/les caractéristiques du modèle (année de sortie, caractéristiques, cote, rareté, réédition).
3. Si une requête ne donne rien d'exploitable, REFORMULE (retire le modèle, élargis à la gamme, essaie la référence seule, essaie en anglais) et relance. Ne conclus « prix inconnu » qu'après avoir essayé plusieurs formulations.
4. Croise au minimum 3 annonces réelles avant de fixer un prix. Une annonce isolée n'est pas un marché.
5. Retiens de cette recherche les éléments qui DONNENT ENVIE (année de sortie, réputation du modèle, qualité de fabrication, prix neuf, rareté, usages) : ils nourriront la description de vente.

MÉTHODOLOGIE DE PRIX STRICTE :
1. Analyse les prix trouvés : prends la médiane des annonces en état SIMILAIRE (pas les annonces "Neuf" si l'article est usé)
2. Distingue prix NEUF (Amazon, site officiel) du prix OCCASION réel (Leboncoin, Vinted, eBay)
3. Prix recyclerie = 90 % du prix occasion médian constaté (légèrement en dessous du particulier sur Leboncoin)
4. DÉCOTES OBLIGATOIRES selon l'état identifié (par rapport aux annonces Leboncoin en état similaire) :
   - "Bon état" : applique -10 % supplémentaires
   - "État correct" : applique -20 % supplémentaires
   - "À rénover" : applique -35 % — l'article nécessite un investissement
5. DÉCOTES MARCHÉ pour articles à faible demande :
   - Jouets génériques, poupées sans collection : -50 % sur toute référence
   - Mobilier années 90-2000 sans style particulier : -40 %
   - CD, DVD, livres de poche : prix plancher 0,50–1 €
   - Bibelots et déco générique : prix plancher 0,50–3 €
   - Petits électroménagers de marque inconnue : -30 %
6. Arrondis : < 10 € → 0,50 € près | 10–50 € → 1 € près | 50–200 € → 5 € près | > 200 € → 10 € près

FOURCHETTES PLANCHER (minimums absolus en recyclerie) :
- Jouets courants / poupées : 0,50–5 € | Jouets de marque premium (LEGO, Playmobil) : 3–20 €
- Vélo enfant usé : 5–15 € | Vélo enfant bon état marque connue : 15–35 €
- Livres : 0,50–2 € | CD/DVD : 0,50–1 €
- Bibelots/déco générique : 0,50–3 €
- Vêtements : 1–5 € pièce

RÉDACTION DE LA DESCRIPTION (texte affiché en boutique en ligne — c'est une VITRINE, pas un rapport d'expertise) :
- Écris comme un vendeur de seconde main passionné : concret, chaleureux, incarné. Le lecteur doit se projeter avec l'objet chez lui.
- Structure en 3 à 5 phrases : (1) ce que c'est précisément, marque et modèle identifiés par la recherche ; (2) ce qui le rend intéressant — qualité de fabrication, réputation du modèle, matière, style, prix neuf de référence s'il est élevé ; (3) à quel usage / à qui il s'adresse concrètement ; (4) éventuellement l'état en une formule courte et positive.
- Appuie-toi sur ce que la RECHERCHE WEB t'a appris (année, gamme, réputation, prix neuf) : c'est ce qui différencie une bonne description d'un texte creux.
- INTERDIT de mentionner ce qui disparaît au nettoyage ou à la préparation : poussière, saleté, traces de doigts, taches superficielles, toile d'araignée, odeur, cheveux, terre. Tous les articles sont NETTOYÉS et vérifiés avant la vente. Ne le mentionne jamais, même pour être « honnête ».
- INTERDIT aussi : les phrases creuses et interchangeables ("article d'occasion en bon état", "peut convenir à de nombreux usages", "idéal pour les amateurs", "fonctionnel et pratique", "un bon rapport qualité-prix"), les listes de dimensions estimées au pif, la répétition de l'état déjà affiché à côté du prix, la mention de la recyclerie ou du geste écologique (déjà présent partout sur le site).
- À CONSERVER en revanche : les défauts RÉELS et permanents (rayure marquée, éclat, fissure, pièce manquante, élément non fonctionnel, accessoire absent). Une seule phrase factuelle en fin de description, sans dramatiser.
- Pas de superlatifs mensongers, pas de majuscules criardes, pas d'emoji, pas de point d'exclamation en rafale.

GARDE-FOUS ANTI-OPTIMISME :
- Un article "Bon état" ne vaut JAMAIS autant qu'un article "Très bon état"
- Un jouet d'enfant utilisé = article usé. Pas d'exception.
- Si tu hésites entre deux prix → prends le PLUS BAS
- La recyclerie est légèrement moins chère que Leboncoin, pas bradée : 10 % en dessous est la cible
- Un article qui traîne invendu est un coût, pas un actif

Retourne UNIQUEMENT un objet JSON valide (sans markdown) :
{
  "title": "Titre précis et attractif en français, max 60 caractères : marque + modèle + ce que c'est (ex: 'Robot pâtissier Moulinex Masterchef Gourmet'). Pas de superlatifs, pas de mention d'état.",
  "category": "Exactement une de : Maison et Jardin | Électronique | Loisirs",
  "subcategory": "Exactement une des sous-catégories disponibles",
  "condition": "Reprend l'état évalué à l'étape 1 — ne l'améliore pas sans raison solide",
  "description": "3 à 5 phrases de vente, en suivant la section RÉDACTION DE LA DESCRIPTION : objet identifié précisément (marque/modèle confirmés par la recherche), ce qui le rend intéressant, à quel usage il sert, et seulement s'il y en a, les défauts permanents en une phrase. Jamais de poussière/saleté, jamais de phrases creuses.",
  "price": <prix de vente recyclerie en euros, applique toutes les décotes>,
  "originalPrice": <prix neuf constaté (Amazon/site officiel), null si vraiment inconnu>,
  "priceRationale": "1 phrase précise : source du prix + calcul (ex: 'Leboncoin médiane 22 €, état correct -20 %, recyclerie -10 % = 16 €')",
  "priceJustification": "2 à 4 phrases expliquant le raisonnement complet : pourquoi cet article vaut ce prix, quels facteurs ont influencé la note d'état, pourquoi la demande est forte ou faible pour cet article, et si applicable ce qui pourrait faire varier le prix (ex: marque, rareté, tendance du marché)",
  "valueColor": "<hex strict : #ef4444 rouge si price/originalPrice < 5 % | #f97316 orange 5–10 % | #eab308 jaune 10–20 % | #84cc16 vert clair 20–30 % | #22c55e vert > 30 % ou article rare très demandé>",
  "valueLabel": "Phrase courte et honnête sur la valeur réelle (ex: 'Faible valeur — article courant usé', 'Valeur correcte pour l'état', 'Bon potentiel de revente', 'Article rare et demandé')",
  "onlineEligible": <true si le prix recommandé est supérieur ou égal à 10 €, sinon false>,
  "recommendedSaleMode": "single" ou "bundle",
  "singleSaleNote": "Note IA courte : explique l'intérêt ou le risque de vendre l'article seul.",
  "bundleSaleNote": "Note IA courte : explique avec quels articles du même univers il pourrait être vendu en lot, et pourquoi.",
  "listingRecommendation": "Phrase opérationnelle en français : recommande clairement soit 'mise en ligne seule', soit 'mise en attente pour lot'. Même si price >= 10, recommande 'bundle' si l'article est plus attractif groupé avec des articles du même univers.",
  "keywords": ["8 à 12 mots-clés précis : marque, licence/univers, personnage, type d'objet, matière, usage. Exemple Mario Kart : mario, nintendo, kart, voiture, circuit, figurine"],
  "themeKey": "clé courte en minuscules pour l'univers exact, pas une catégorie large. Exemples : mario, playmobil-pirates, lego-star-wars, vaisselle-vintage, livres-policiers",
  "sources": ["URLs complètes (https://…) des pages réellement consultées pour fixer le prix : annonces Leboncoin/Vinted/eBay, fiche produit Amazon/site officiel. 2 à 5 liens. Tableau vide si aucune source web."]
}

Sous-catégories :
- Maison et Jardin : Ameublement, Électroménager, Décoration, Bricolage, Vaisselle
- Électronique : Ordinateurs, Téléphones, Tablettes, Photo, audio et vidéo, Accessoires informatique
- Loisirs : Jeux et Jouets, Vélos, CD - Musique, DVD - Films, Instruments de musique, Livres`;

export type ArticleAIAnalysis = {
  title: string;
  category: keyof typeof CATEGORIES;
  subcategory: string;
  condition: (typeof CONDITIONS)[number];
  description: string;
  price: number;
  originalPrice: number | null;
  priceRationale?: string;
  priceJustification?: string;
  valueColor: string;
  valueLabel: string;
  onlineEligible?: boolean;
  recommendedSaleMode?: "single" | "bundle";
  singleSaleNote?: string;
  bundleSaleNote?: string;
  listingRecommendation?: string;
  keywords?: string[];
  themeKey?: string;
  sources?: string[];
  backgroundPrompt?: string;
};

type IdentificationResult = {
  name: string;
  brand: string | null;
  model?: string | null;
  modelHypotheses?: string[];
  visibleText?: string | null;
  estimatedCondition: string;
  conditionJustification: string;
  searchQueries: string[];
  keyDetails: string;
  backgroundPrompt: string;
};

export type LotAnalysisGroup = {
  title: string;
  reason: string;
  suggestedPrice: number;
  articleIds: string[];
  merchandisingNote?: string;
};

type LotAnalysisResult = {
  groups: LotAnalysisGroup[];
};

/**
 * Extrait le premier objet JSON complet d'une réponse de modèle.
 *
 * Les modèles « search » répondent en prose puis glissent le JSON dans un bloc
 * ```json. On privilégie donc le contenu du bloc, et à défaut on isole l'objet
 * en comptant les accolades (un `lastIndexOf("}")` naïf ramassait la prose et
 * les citations qui suivent parfois l'objet).
 */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), raw.trim()].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const char = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Appel Chat Completions renvoyant du JSON.
 *
 * Les modèles gpt-5 n'acceptent plus `max_tokens` (remplacé par
 * `max_completion_tokens`) ni une `temperature` autre que 1 : la conversion est
 * faite ici pour que les appelants restent lisibles.
 */
async function callOpenAI<T>(
  apiKey: string,
  { max_tokens, temperature: _temperature, ...rest }: Record<string, unknown> & {
    max_tokens?: number;
    temperature?: number;
  },
): Promise<T> {
  const body = {
    ...rest,
    ...(max_tokens !== undefined ? { max_completion_tokens: max_tokens } : {}),
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Erreur API OpenAI (${response.status}): ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
  };

  const choice = data.choices?.[0];
  const raw = choice?.message?.content ?? "";
  const json = extractJsonObject(raw);

  if (!json) {
    // `finish_reason: "length"` = réponse coupée par `max_tokens` : le JSON est
    // tronqué et illisible. C'était la cause la plus fréquente des échecs de run.
    if (choice?.finish_reason === "length") {
      throw new Error(
        "Réponse IA tronquée (limite de jetons atteinte) — relancez l'article.",
      );
    }
    throw new Error("Réponse IA non parseable : " + raw.slice(0, 200));
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error("Réponse IA non parseable : " + json.slice(0, 200));
  }
}

/**
 * Appel avec recherche web, via l'API Responses et l'outil `web_search`.
 *
 * C'est le remplaçant de `gpt-4o-search-preview` : le modèle navigue lui-même
 * pour trouver des prix réels, puis rend le JSON demandé. La réponse mêle
 * souvent prose, citations et bloc ```json — `extractJsonObject` s'en charge.
 */
async function callOpenAIWebSearch<T>(
  apiKey: string,
  {
    instructions,
    input,
    maxOutputTokens,
  }: { instructions: string; input: string; maxOutputTokens: number },
): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input,
      tools: [{ type: "web_search" }],
      max_output_tokens: maxOutputTokens,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Erreur API OpenAI (${response.status}): ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    status?: string;
    output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
  };

  const raw = (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");

  const json = extractJsonObject(raw);
  if (!json) {
    if (data.status === "incomplete") {
      throw new Error(
        "Réponse IA tronquée (limite de jetons atteinte) — relancez l'article.",
      );
    }
    throw new Error("Réponse IA non parseable : " + raw.slice(0, 200));
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error("Réponse IA non parseable : " + json.slice(0, 200));
  }
}

function fallbackLotAnalysis(
  articles: Array<{
    _id: string;
    title: string;
    description?: string;
    price: number;
    category: string;
    subcategory?: string;
    status: string;
    keywords?: string[];
    themeKey?: string;
  }>,
): LotAnalysisResult {
  const groups = new Map<string, typeof articles>();
  for (const article of articles) {
    const key = article.themeKey || fallbackThemeKey(article);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), article]);
  }

  return {
    groups: Array.from(groups.entries())
      .map(([key, items]) => {
        const sorted = [...items].sort((a, b) => a.price - b.price);
        const total = sorted.reduce((sum, article) => sum + article.price, 0);
        return {
          title: lotTitleFromKey(key, sorted),
          reason:
            "Regroupement automatique par thème précis et mots-clés proches. À valider avant mise en ligne.",
          suggestedPrice: discountedBundlePrice(total),
          articleIds: sorted.map((article) => article._id),
          merchandisingNote: "Lot intéressant si la sélection raconte le même usage client.",
        };
      })
      .filter((group) => group.articleIds.length >= 2)
      .slice(0, 12),
  };
}

function normalizeKeyword(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const THEME_PATTERNS: Array<{ words: string[]; key: string }> = [
  { words: ["mario", "kart", "luigi", "toad", "bowser", "yoshi", "peach", "nintendo"], key: "mario" },
  { words: ["batman", "gotham", "joker", "bruce wayne"], key: "batman" },
  { words: ["superman", "wonder woman", "aquaman", "flash", "dc comics", "justice league"], key: "dc-super-heros" },
  { words: ["ironman", "iron", "avengers", "thor", "hulk", "captain", "america", "marvel", "wakanda", "black panther", "hawkeye", "falcon", "antman", "ant man"], key: "marvel" },
  { words: ["spiderman", "spider"], key: "spider-man" },
  { words: ["buzz", "lightyear", "woody", "jessie", "slinky", "toy story", "lotso", "hamm", "rex"], key: "toy-story" },
  { words: ["playmobil"], key: "playmobil" },
  { words: ["pirate", "pirates", "bateau", "corsaire"], key: "pirates" },
  { words: ["lego"], key: "lego" },
  { words: ["pokemon", "pikachu", "charizard", "bulbasaur", "squirtle", "eevee", "mewtwo"], key: "pokemon" },
  { words: ["barbie", "ken"], key: "barbie" },
  { words: ["star wars", "starwars", "jedi", "sith", "yoda", "darth", "vader", "stormtrooper", "mandalorian", "lightsaber"], key: "star-wars" },
  { words: ["harry potter", "hogwarts", "hermione", "dumbledore", "voldemort", "poudlard", "weasley"], key: "harry-potter" },
  { words: ["minions", "gru", "despicable"], key: "minions" },
  { words: ["frozen", "elsa", "anna", "olaf", "reine des neiges"], key: "frozen" },
  { words: ["cars", "mcqueen", "lightning", "radiator springs"], key: "cars-pixar" },
  { words: ["dinosaure", "dinosaures", "dino", "jurassic"], key: "dinosaures" },
  { words: ["foot", "football", "ballon"], key: "football" },
];

function fallbackThemeKey(article: {
  title: string;
  description?: string;
  keywords?: string[];
}) {
  const text = normalizeKeyword(
    `${article.title} ${article.description ?? ""} ${(article.keywords ?? []).join(" ")}`,
  );
  const words = new Set(text.split(/\s+/).filter(Boolean));
  const fullText = text;

  for (const pattern of THEME_PATTERNS) {
    const matched = pattern.words.some((w) => {
      if (w.includes(" ")) return fullText.includes(w);
      return words.has(w);
    });
    if (matched) return pattern.key;
  }
  return "";
}

function lotTitleFromKey(
  key: string,
  articles: Array<{ keywords?: string[]; subcategory?: string }>,
) {
  const words = key
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  if (words.length > 0) return `Lot univers ${words.join(" ")}`;
  return `Lot ${articles[0]?.subcategory || "sélection"}`;
}

function discountedBundlePrice(total: number) {
  const discountRate = total >= 40 ? 0.82 : 0.85;
  return Math.max(10, Math.round(total * discountRate));
}

function sanitizeLotGroups(
  groups: LotAnalysisGroup[],
  articles: Array<{
    _id: string;
    price: number;
    themeKey?: string;
  }>,
) {
  const articleById = new Map(articles.map((article) => [article._id, article]));
  return groups
    .map((group) => {
      const uniqueIds = Array.from(new Set(group.articleIds));
      const groupArticles = uniqueIds
        .map((id) => articleById.get(id))
        .filter((article): article is NonNullable<typeof article> => Boolean(article));
      const themeKeys = Array.from(
        new Set(groupArticles.map((article) => article.themeKey).filter(Boolean)),
      );
      const total = groupArticles.reduce((sum, article) => sum + article.price, 0);
      return {
        ...group,
        articleIds: groupArticles.map((article) => article._id),
        suggestedPrice: Math.min(
          Math.max(10, Number(group.suggestedPrice) || 10),
          discountedBundlePrice(total),
        ),
        _valid: groupArticles.length >= 2 && themeKeys.length === 1,
      };
    })
    .filter((group) => group._valid)
    .map(({ _valid, ...group }) => group)
    .slice(0, 12);
}

export const analyzePotentialLots = action({
  args: {},
  handler: async (ctx): Promise<LotAnalysisResult> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "articles", "analyze")) {
      throw new Error("Accès CRM insuffisant.");
    }

    const articles = await ctx.runQuery(api.articles.listForLotAnalysis, {});
    if (articles.length < 2) return { groups: [] };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return fallbackLotAnalysis(articles);

    try {
      const result = await callOpenAI<LotAnalysisResult>(apiKey, {
        model: MODEL,
        max_tokens: 2000,
        messages: [
          {
            role: "system",
            content:
              "Tu es responsable merchandising d'une recyclerie française. Ton objectif est de MAXIMISER le nombre de lots proposés. Regroupe les articles par univers, personnage, licence ou franchise. Sois LARGE dans tes regroupements : tous les superhéros Marvel ensemble, tous les personnages Toy Story ensemble, tous les articles Batman ensemble, etc. Un même personnage en plusieurs tailles = lot parfait. Une même franchise = lot. Retourne uniquement du JSON valide, sans commentaires.",
          },
          {
            role: "user",
            content: `Articles disponibles pour analyse de lots :
${JSON.stringify(
  articles.map((article: (typeof articles)[number]) => ({
    id: article._id,
    title: article.title,
    description: article.description.slice(0, 180),
    price: article.price,
    subcategory: article.subcategory,
    keywords: article.keywords?.slice(0, 8),
    themeKey: article.themeKey,
  })),
  null,
  0,
)}

Retourne ce format JSON exact :
{
  "groups": [
    {
      "title": "Titre vendeur du lot",
      "reason": "Pourquoi ces articles vont bien ensemble",
      "suggestedPrice": 25,
      "articleIds": ["id1", "id2"],
      "merchandisingNote": "Conseil court pour l'équipe"
    }
  ]
}

Règles IMPÉRATIVES :
- Minimum 2 articles, maximum 8 par lot.
- Groupe par univers/franchise/personnage : Batman x2 = lot Batman, Iron Man + Spider-Man = lot Marvel, Buzz Lightyear + Slinky = lot Toy Story.
- Un même personnage en différentes tailles = lot idéal.
- Des personnages de la même franchise (Marvel, DC, Toy Story, Star Wars, Nintendo...) = lot valide.
- NE PAS rejeter un lot parce que les articles sont en statut "disponible". Analyser tous les statuts.
- Nom du lot : court et vendeur ("Lot Batman DC", "Lot super-héros Marvel", "Lot Toy Story Pixar", "Lot univers Mario").
- Prix suggéré : somme des prix × 0.82, minimum 8 €.
- Utilise UNIQUEMENT les IDs fournis dans la liste.
- Si tu ne trouves pas au moins 2 groupes cohérents, force quand même les meilleures combinaisons possibles.`,
          },
        ],
      });
      const sanitized = sanitizeLotGroups(result.groups ?? [], articles);
      return sanitized.length > 0 ? { groups: sanitized } : fallbackLotAnalysis(articles);
    } catch {
      return fallbackLotAnalysis(articles);
    }
  },
});

export const analyzeArticleImage = action({
  args: { storageId: v.id("_storage"), extraDetails: v.optional(v.string()) },
  handler: async (ctx, { storageId, extraDetails }): Promise<ArticleAIAnalysis> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "articles", "analyze")) {
      throw new Error("Accès CRM insuffisant.");
    }

    const details = extraDetails?.trim();
    const detailsBlock = details
      ? `\n\nPrécisions fournies par l'équipe (informations fiables qui priment sur la photo, ex. modèle exact, RAM, capacité, année, options) :\n${details}`
      : "";

    const imageUrl = await ctx.storage.getUrl(storageId);
    if (!imageUrl) throw new Error("Image introuvable en stockage.");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey)
      throw new Error(
        "Clé OpenAI non configurée. Exécutez : npx convex env set OPENAI_API_KEY sk-...",
      );

    // ── Étape 1 : identification visuelle ──────────────────────────────────
    const identification = await callOpenAI<IdentificationResult>(apiKey, {
      model: MODEL,
      // 400 jetons coupaient régulièrement le JSON d'identification en plein
      // milieu (finish_reason « length »), ce qui faisait échouer le run.
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: IDENTIFICATION_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: `Identifie cet article.${detailsBlock}` },
          ],
        },
      ],
    });

    // ── Étape 2 : recherche marché + valorisation ──────────────────────────
    // Le modèle navigue lui-même sur le web pour trouver des prix réels.
    // Le modèle omet parfois `searchQueries` : sans garde, l'accès à
    // `searchQueries[0]` faisait planter l'action entière.
    const queries =
      Array.isArray(identification.searchQueries) && identification.searchQueries.length > 0
        ? identification.searchQueries
        : [identification.name];

    const hypotheses = Array.isArray(identification.modelHypotheses)
      ? identification.modelHypotheses.filter(Boolean)
      : [];

    const searchUserPrompt = `Article à évaluer :
- Nom : ${identification.name}${identification.brand ? ` (marque : ${identification.brand})` : ""}
${identification.model ? `- Modèle / référence lue sur la photo : ${identification.model}\n` : ""}${hypotheses.length > 0 ? `- Modèles possibles à départager par la recherche : ${hypotheses.join(" | ")}\n` : ""}${identification.visibleText ? `- Texte lisible sur la photo : ${identification.visibleText}\n` : ""}- État : ${identification.estimatedCondition}
- Justification de l'état (défauts constatés, usage INTERNE — ne recopie pas la saleté ou la poussière dans la description) : ${identification.conditionJustification}
- Détails clés : ${identification.keyDetails}

ÉTAPE A — IDENTIFIE d'abord le produit exact sur le web (fiche constructeur, notice, test, fiche marchand) et tranche entre les hypothèses de modèle.
ÉTAPE B — RECHERCHE ensuite les prix réels, en enchaînant plusieurs requêtes et en les affinant si les résultats sont pauvres. Pistes de départ :
${queries.map((q, i) => `${i + 1}. "${q}"`).join("\n")}
Ajoute au moins une recherche sur les ventes RÉALISÉES (vinted / ebay vendus) et une sur le prix neuf actuel.

IMPORTANT :
- Applique toutes les décotes selon l'état "${identification.estimatedCondition}" et les défauts constatés. Ne sois pas généreux sur le prix.
- La description, elle, est une vitrine : vendeuse, précise, nourrie par ce que la recherche t'a appris. Jamais de poussière, saleté ni de phrases creuses.${detailsBlock}

Produis l'évaluation JSON complète basée sur les résultats trouvés.`;

    const result = await callOpenAIWebSearch<ArticleAIAnalysis>(apiKey, {
      instructions: VALUATION_PROMPT,
      input: searchUserPrompt,
      // Relevé à 6000 : la recherche web approfondie (plusieurs requêtes
      // enchaînées) consomme des jetons avant même le JSON final.
      maxOutputTokens: 6000,
    });

    // Sanity checks
    sanitizeArticleAnalysis(result);
    result.backgroundPrompt = identification.backgroundPrompt;

    return result;
  },
});

// ─── Génération d'article à partir de mots-clés (sans photo) ───────────────────

function sanitizeArticleAnalysis(
  result: ArticleAIAnalysis & { weightKg?: number },
): ArticleAIAnalysis & { weightKg?: number } {
  if (!Object.keys(CATEGORIES).includes(result.category)) {
    result.category = "Maison et Jardin";
  }
  result.price = Math.max(0, Number(result.price) || 0);
  result.originalPrice =
    result.originalPrice != null ? Number(result.originalPrice) || null : null;
  result.weightKg =
    result.weightKg != null ? Math.max(0, Number(result.weightKg) || 0) : undefined;
  result.onlineEligible = result.price >= 10;
  result.recommendedSaleMode =
    result.recommendedSaleMode === "bundle" || result.price < 10
      ? "bundle"
      : "single";
  if (!result.singleSaleNote) {
    result.singleSaleNote =
      result.price >= 10
        ? "Peut être vendu seul car il atteint le seuil minimum de 10 €."
        : "Vente seule déconseillée car le prix estimé est inférieur au minimum de mise en ligne.";
  }
  if (!result.bundleSaleNote) {
    result.bundleSaleNote =
      result.price >= 10
        ? "Peut aussi servir à renforcer un lot thématique si des articles proches existent."
        : "À conserver pour un lot avec des articles similaires afin d'atteindre un prix vendable.";
  }
  if (!result.listingRecommendation) {
    result.listingRecommendation =
      result.recommendedSaleMode === "single"
        ? "Cet article atteint le seuil minimum de 10 € et peut être mis en ligne seul."
        : "Cet article est plus pertinent en attente pour un lot avec des articles du même univers.";
  }
  result.keywords = Array.from(
    new Set((result.keywords ?? []).map(normalizeKeyword).filter(Boolean)),
  ).slice(0, 12);
  result.sources = Array.from(
    new Set(
      (Array.isArray(result.sources) ? result.sources : [])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => /^https?:\/\//i.test(s)),
    ),
  ).slice(0, 6);
  result.themeKey =
    result.themeKey?.trim() ||
    fallbackThemeKey({
      title: result.title,
      description: result.description,
      keywords: result.keywords,
    });
  return result;
}

export const generateArticleFromKeywords = action({
  args: { keywords: v.string() },
  handler: async (
    ctx,
    { keywords },
  ): Promise<ArticleAIAnalysis & { weightKg?: number }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "articles", "analyze")) {
      throw new Error("Accès CRM insuffisant.");
    }

    const brief = keywords.trim();
    if (!brief) throw new Error("Renseignez au moins quelques mots-clés.");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey)
      throw new Error(
        "Clé OpenAI non configurée. Exécutez : npx convex env set OPENAI_API_KEY sk-...",
      );

    const userPrompt = `Article à créer à partir des mots-clés / indications fournis par l'équipe (il n'y a PAS de photo, déduis l'article le plus probable) :
"""
${brief}
"""

Étapes :
1. Déduis l'objet le plus probable décrit par ces mots-clés (marque, modèle, type, matière si possible).
2. Choisis un état réaliste : "Bon état" par défaut, sauf si les mots-clés indiquent un autre état (neuf, à rénover, déstockage…).
3. Identifie d'abord le produit exact sur le web (marque, modèle, référence, année, gamme) en enchaînant plusieurs recherches et en les reformulant si les résultats sont pauvres.
4. Recherche ensuite sur Leboncoin, Vinted, eBay France (ventes réalisées) et Amazon France les prix actuels pour cet article en état similaire, puis applique TOUTE la méthodologie de valorisation et les décotes.
5. Rédige la description comme une vitrine de boutique : vendeuse et précise, nourrie par ce que la recherche t'a appris. Aucune mention de poussière ou de saleté, aucune phrase creuse.

En plus des champs JSON habituels, ajoute le champ "weightKg" : le poids estimé de l'article en kilogrammes (nombre, ex: 0.5, 2, 12).`;

    const result = await callOpenAIWebSearch<ArticleAIAnalysis & { weightKg?: number }>(
      apiKey,
      {
        instructions:
          VALUATION_PROMPT +
          `\n\nIMPORTANT : ajoute aussi le champ "weightKg" (poids estimé en kilogrammes, nombre) dans le JSON de réponse.`,
        input: userPrompt,
        maxOutputTokens: 6000,
      },
    );

    return sanitizeArticleAnalysis(result);
  },
});

// ─── Description de lot générée par l'IA ──────────────────────────────────────

export const generateLotDescription = action({
  args: {
    articleIds: v.array(v.id("articles")),
    title: v.optional(v.string()),
  },
  handler: async (ctx, { articleIds, title }): Promise<{ description: string }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "articles", "create")) {
      throw new Error("Accès CRM insuffisant.");
    }

    const items = await ctx.runQuery(api.articles.getManyForLot, {
      ids: articleIds,
    });
    if (items.length === 0) throw new Error("Aucun article dans ce lot.");

    const cleanTitle = title?.trim();
    const fallback = (): { description: string } => {
      const lines = items.map((item) => `• ${item.title}`).join("\n");
      return {
        description: `Lot de ${items.length} articles${
          cleanTitle ? ` — ${cleanTitle}` : ""
        } :\n${lines}\n\nUn ensemble cohérent à petit prix, à récupérer en boutique. Un bon geste pour la planète comme pour le porte-monnaie.`,
      };
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return fallback();

    try {
      const result = await callOpenAI<{ description: string }>(apiKey, {
        model: MODEL,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "Tu es rédacteur produit pour une recyclerie française. Tu rédiges des descriptions de lots attractives, chaleureuses et honnêtes pour une boutique de seconde main. Retourne uniquement du JSON valide, sans commentaires.",
          },
          {
            role: "user",
            content: `Rédige une description de vente pour un lot${
              cleanTitle ? ` intitulé "${cleanTitle}"` : ""
            } composé des articles suivants :
${JSON.stringify(items, null, 0)}

Consignes :
- 3 à 5 phrases, ton chaleureux et vendeur, en français, concrètes et incarnées.
- Mets en valeur la cohérence du lot (univers, thème, usage commun) et l'intérêt d'acheter l'ensemble plutôt que séparément.
- Mentionne le nombre d'articles (${items.length}) et donne envie, sans inventer de caractéristiques absentes.
- INTERDIT de parler de poussière, saleté ou traces d'usage superficielles : tous les articles sont nettoyés avant la vente.
- INTERDIT les phrases creuses et interchangeables ("articles d'occasion en bon état", "idéal pour les amateurs", "un bon rapport qualité-prix").
- Termine par une phrase courte sur la démarche solidaire et de seconde main.

Retourne ce JSON exact : { "description": "texte de la description" }`,
          },
        ],
      });
      const description = result.description?.trim();
      return description ? { description } : fallback();
    } catch {
      return fallback();
    }
  },
});

// ─── Premium background generation via gpt-image-1 ────────────────────────────

function imageFilenameForContentType(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    return "product.jpg";
  }
  if (contentType.includes("webp")) {
    return "product.webp";
  }
  return "product.png";
}

function sanitizeImageEditPrompt(prompt: string) {
  return prompt
    .replace(
      /\b(skin|nude|body|naked|intimate|sensual|erotic|seductive)\b/gi,
      "",
    )
    .replace(
      /\b(mario|luigi|peach|bowser|nintendo|pokemon|pokémon|disney|marvel|pixar|star wars|harry potter|lego)\b/gi,
      "toy",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function editOneImage(
  ctx: ActionCtx,
  apiKey: string,
  storageId: string,
  backgroundPrompt: string,
): Promise<{ storageId: string; url: string }> {
  const imageUrl = await ctx.storage.getUrl(storageId as Id<"_storage">);
  if (!imageUrl) throw new Error(`Image introuvable : ${storageId}`);

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok)
    throw new Error(`Téléchargement image impossible (${imageResponse.status})`);

  const rawBuffer = await imageResponse.arrayBuffer();
  const contentType = imageResponse.headers.get("content-type") ?? "image/png";
  const normalizedContentType = contentType.includes("jpeg")
    ? "image/jpeg"
    : contentType.includes("webp")
      ? "image/webp"
      : "image/png";
  const imageBlob = new Blob([rawBuffer], { type: normalizedContentType });

  const safeBackground =
    sanitizeImageEditPrompt(backgroundPrompt) ||
    "Clean warm neutral product photography studio background, simple surface, soft natural light, subtle shadow.";

  const editPrompt =
    `Edit this product photo for an online second-hand shop. ` +
    `Preserve the item exactly as it appears. Do not recreate, redesign, stylize, or add details to the item. ` +
    `Only replace the surrounding background with: ${safeBackground}. ` +
    `No people, no text, no logos added, clean commercial product photography.`;

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("image", imageBlob, imageFilenameForContentType(normalizedContentType));
  formData.append("prompt", editPrompt);
  formData.append("n", "1");
  formData.append("size", "1024x1024");
  formData.append("quality", "high");

  const editResponse = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!editResponse.ok) {
    const errText = await editResponse.text();
    if (editResponse.status === 400 && errText.includes("moderation_blocked")) {
      throw new Error(
        "OpenAI a bloqué le détourage de cette image. La cause la plus fréquente est un personnage, une marque ou un logo détecté dans la photo. Le prompt a été neutralisé, réessayez maintenant.",
      );
    }
    throw new Error(`OpenAI image edit (${editResponse.status}): ${errText.slice(0, 400)}`);
  }

  const editData = (await editResponse.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    error?: { message: string; code?: string };
  };

  if (editData.error) {
    if (editData.error.code === "moderation_blocked") {
      throw new Error(
        "OpenAI a bloqué le détourage de cette image. La cause la plus fréquente est un personnage, une marque ou un logo détecté dans la photo. Le prompt a été neutralisé, réessayez maintenant.",
      );
    }
    throw new Error(`OpenAI: ${editData.error.message}`);
  }

  const item = editData.data?.[0];
  if (!item) throw new Error("Aucune image retournée par OpenAI.");

  let processedBlob: Blob;
  if (item.b64_json) {
    const binary = atob(item.b64_json);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    processedBlob = new Blob([bytes], { type: "image/png" });
  } else if (item.url) {
    const r = await fetch(item.url);
    processedBlob = await r.blob();
  } else {
    throw new Error("Données image absentes dans la réponse OpenAI.");
  }

  const newId = await ctx.storage.store(processedBlob);
  const newUrl = await ctx.storage.getUrl(newId);
  if (!newUrl) throw new Error("URL introuvable après stockage.");

  return { storageId: newId as string, url: newUrl };
}

// ─── Background job pattern (avoids 60s WebSocket timeout) ───────────────────

export const createBgJob = mutation({
  args: {
    storageIds: v.array(v.id("_storage")),
    backgroundPrompt: v.string(),
    articleTitle: v.optional(v.string()),
  },
  handler: async (ctx, { storageIds, backgroundPrompt, articleTitle }) => {
    await requireCrmPermission(ctx, "articles", "analyze");

    const jobId = await ctx.db.insert("bgJobs", {
      status: "pending",
      storageIds,
      backgroundPrompt,
      ...(articleTitle ? { articleTitle } : {}),
    });

    await ctx.scheduler.runAfter(0, internal.ai.processBgJob, { jobId });
    return jobId;
  },
});

export const getBgJob = query({
  args: { jobId: v.id("bgJobs") },
  handler: async (ctx, { jobId }) => {
    await requireCrmPermission(ctx, "articles", "analyze");
    return ctx.db.get(jobId);
  },
});

export const processBgJob = internalAction({
  args: { jobId: v.id("bgJobs") },
  handler: async (ctx, { jobId }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.ai.updateBgJob, {
        jobId,
        status: "error",
        error: "Clé OpenAI non configurée.",
      });
      return;
    }

    const job = await ctx.runQuery(internal.ai.getBgJobInternal, { jobId });
    if (!job) return;

    try {
      const results: Array<{ originalStorageId: Id<"_storage">; newStorageId: Id<"_storage">; url: string }> = [];
      for (const storageId of job.storageIds) {
        const r = await editOneImage(ctx, apiKey, storageId, job.backgroundPrompt);
        results.push({
          originalStorageId: storageId,
          newStorageId: r.storageId as Id<"_storage">,
          url: r.url,
        });
      }
      await ctx.runMutation(internal.ai.updateBgJob, { jobId, status: "done", results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.ai.updateBgJob, { jobId, status: "error", error: msg });
    }
  },
});

export const getBgJobInternal = internalQuery({
  args: { jobId: v.id("bgJobs") },
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

export const updateBgJob = internalMutation({
  args: {
    jobId: v.id("bgJobs"),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
    results: v.optional(
      v.array(v.object({ originalStorageId: v.id("_storage"), newStorageId: v.id("_storage"), url: v.string() })),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, status, results, error }) => {
    await ctx.db.patch(jobId, { status, ...(results ? { results } : {}), ...(error ? { error } : {}) });
  },
});
