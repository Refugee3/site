// Answer spots ("mark detection", OMR): where on a blank worksheet each question is answered, and what was found there on a
// student's paper. Every box is in normalized page coordinates of the BLANK worksheet page (0..1, origin top left), so the
// map is independent of the resolution pages are rendered at.

/** A rectangle in normalized page coordinates (x, y: top left; w, h: size), all in 0..1. */
export interface SpotBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How a question is answered on the page: `choice` (circle, tick, fill or cross one of the printed options), `write_in` (a
 * blank, a box or an empty area the student writes in), `matching` (letters written in blanks next to the items), `diagram`
 * (something drawn).
 */
export const SPOT_KINDS = ["choice", "write_in", "matching", "diagram"] as const;
export type SpotKind = (typeof SPOT_KINDS)[number];

/** Where an answer-spot map came from: the PDF's text layer, the AI (a scanned blank), or the teacher alone. */
export const SPOT_SOURCES = ["text", "ai", "manual"] as const;
export type SpotSource = (typeof SPOT_SOURCES)[number];

/** One printed option of a choice question: the value it stands for ("B", "True", "are") and the box around it. */
export interface SpotOption {
  value: string;
  box: SpotBox;
}

/** The answer spots of one question on one page. */
export interface QuestionSpots {
  id: string;
  /** The question label as printed ("3", "3a"), or as the teacher typed it. */
  label: string;
  /** The key item it is linked to, by label; null = not linked (not used for grading). */
  itemLabel: string | null;
  kind: SpotKind;
  /** Choice: several options may be marked on purpose (the key expects a set). */
  multi: boolean;
  /** "Use mark detection" for this question; off, the question is read by the AI as before. */
  enabled: boolean;
  /** 1-based page of the blank worksheet. */
  page: number;
  /** Choice only. */
  options: SpotOption[];
  /** Write-in, matching and diagram: the areas the answer is written or drawn in (one or more). */
  boxes: SpotBox[];
}

/** A grayscale image: one byte per pixel (0 black … 255 white), row by row. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * An affine map between normalized page coordinates: u' = a·u + b·v + c, v' = d·u + e·v + f. Registration gives the map
 * from the blank page to the student's page.
 */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** What mark detection found for one item, stored with its judgment so the review page can show the crop. */
export interface SpotEvidence {
  kind: SpotKind;
  /** 1-based page of the paper (= the blank page). */
  page: number;
  /** The area to show, in blank page coordinates (the question's spots, padded). */
  crop: SpotBox;
  /** Blank page → this paper's page. */
  map: Affine;
  /** Choice: every option with its added-ink score (fraction of its box). */
  options?: Array<{ value: string; box: SpotBox; ink: number }>;
  /** Choice: the options read as marked. */
  marked?: string[];
  /** Write-in, matching, diagram: the areas and the added ink in them. */
  boxes?: SpotBox[];
  ink?: number;
}
