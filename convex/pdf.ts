/**
 * Générateur de PDF minimal, sans dépendance.
 *
 * Le backend est partagé par les 7 apps de l'écosystème : y ajouter une
 * librairie PDF alourdirait chacun de leurs déploiements pour un besoin qui se
 * limite à composer une facture d'une page. On écrit donc directement le
 * format, qui pour ce cas se réduit à un catalogue, une page, deux polices
 * standard et un flux de contenu.
 *
 * Limites assumées : polices Helvetica uniquement (aucune police à embarquer),
 * encodage WinAnsi (couvre le français), pas d'images.
 */

export const PAGE_WIDTH = 595; // A4 à 72 dpi
export const PAGE_HEIGHT = 842;
export const MARGIN = 52;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Couleur RVB, composantes de 0 à 1. */
export type PdfColor = [number, number, number];

export type PdfText = {
  kind: "text";
  text: string;
  /** Taille en points (défaut 10). */
  size?: number;
  bold?: boolean;
  color?: PdfColor;
  /** Décalage horizontal depuis la marge gauche (défaut 0). */
  x?: number;
  /**
   * Largeur de la colonne. Avec `align: "right"`, le texte est calé sur le
   * bord droit de cette colonne ; par défaut la colonne va jusqu'à la marge.
   */
  width?: number;
  align?: "left" | "right";
  /** Espace vertical ajouté avant la ligne. */
  spaceBefore?: number;
  /**
   * Pose le texte sans faire descendre le curseur : indispensable pour écrire
   * deux colonnes côte à côte (émetteur à gauche, client à droite).
   */
  inline?: boolean;
};

/** Filet horizontal pleine largeur. */
export type PdfRule = {
  kind: "rule";
  spaceBefore?: number;
  color?: PdfColor;
  thickness?: number;
};

/** Aplat de couleur, utilisé en fond de l'en-tête du tableau et du total. */
export type PdfBand = {
  kind: "band";
  height: number;
  color: PdfColor;
  spaceBefore?: number;
  /** Le bandeau ne fait pas descendre le curseur : le texte se pose dessus. */
};

/** Espace vertical explicite. */
export type PdfSpace = { kind: "space"; height: number };

export type PdfElement = PdfText | PdfRule | PdfBand | PdfSpace;

/**
 * WinAnsi (CP1252) diffère de Latin-1 sur la plage 0x80-0x9F, où vivent les
 * caractères que produit un traitement de texte français : l'euro et les
 * apostrophes typographiques. Sans cette table, une facture affiche « ? »
 * à la place du symbole monétaire.
 */
const WINANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

function winAnsiByte(char: string): number {
  const extra = WINANSI_EXTRA[char];
  if (extra !== undefined) return extra;
  const code = char.charCodeAt(0);
  return code <= 0xff ? code : 0x3f;
}

/**
 * Largeurs des glyphes Helvetica (millièmes de cadratin), pour les caractères
 * imprimables ASCII. Sans elles, un montant « aligné à droite » flotte de
 * plusieurs millimètres selon les caractères qui le composent — ce qui se voit
 * immédiatement sur une facture.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Largeur d'un texte, en points. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      total += table[code - 32];
    } else {
      // Lettres accentuées et symboles : largeur de la minuscule moyenne. Une
      // approximation suffit, ils sont rares dans les zones alignées à droite.
      total += bold ? 600 : 556;
    }
  }
  return (total / 1000) * size;
}

/** Échappe les caractères réservés d'une chaîne littérale PDF. */
function escapePdfText(value: string): string {
  return value.replace(/([\\()])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

function toBytes(source: string): Uint8Array {
  const bytes = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 1) bytes[i] = winAnsiByte(source[i]);
  return bytes;
}

function colorOp(color: PdfColor, stroke = false) {
  const [r, g, b] = color;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${stroke ? "RG" : "rg"}`;
}

/**
 * Compose un PDF d'une page à partir d'éléments de mise en page.
 * Renvoie les octets, prêts à être stockés ou envoyés en pièce jointe.
 */
export function buildPdf(elements: PdfElement[]): Uint8Array {
  let cursorY = PAGE_HEIGHT - MARGIN;
  const ops: string[] = [];
  let textOpen = false;

  const openText = () => {
    if (!textOpen) {
      ops.push("BT");
      textOpen = true;
    }
  };
  const closeText = () => {
    if (textOpen) {
      ops.push("ET");
      textOpen = false;
    }
  };

  for (const element of elements) {
    if (element.kind === "space") {
      cursorY -= element.height;
      continue;
    }

    if (element.kind === "rule") {
      closeText();
      cursorY -= element.spaceBefore ?? 0;
      const color = element.color ?? [0.82, 0.82, 0.82];
      ops.push(
        colorOp(color, true),
        `${(element.thickness ?? 0.8).toFixed(2)} w`,
        `${MARGIN} ${cursorY.toFixed(2)} m ${(MARGIN + CONTENT_WIDTH).toFixed(2)} ${cursorY.toFixed(2)} l S`,
      );
      continue;
    }

    if (element.kind === "band") {
      closeText();
      cursorY -= element.spaceBefore ?? 0;
      ops.push(
        colorOp(element.color),
        `${MARGIN} ${(cursorY - element.height).toFixed(2)} ${CONTENT_WIDTH} ${element.height} re f`,
      );
      continue;
    }

    const size = element.size ?? 10;
    if (!element.inline) cursorY -= (element.spaceBefore ?? 0) + size * 1.35;
    openText();
    ops.push(`/${element.bold ? "F2" : "F1"} ${size} Tf`);
    ops.push(colorOp(element.color ?? [0.1, 0.1, 0.1]));

    const left = MARGIN + (element.x ?? 0);
    const columnWidth = element.width ?? CONTENT_WIDTH - (element.x ?? 0);
    const x =
      element.align === "right"
        ? left + columnWidth - textWidth(element.text, size, element.bold)
        : left;
    ops.push(`1 0 0 1 ${x.toFixed(2)} ${cursorY.toFixed(2)} Tm`);
    ops.push(`(${escapePdfText(element.text)}) Tj`);
  }
  closeText();

  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${toBytes(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  // La table xref indexe les objets par position exacte en octets : elle se
  // construit donc au fur et à mesure de l'écriture du fichier.
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(toBytes(file).length);
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = toBytes(file).length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    file += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  file +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return toBytes(file);
}
