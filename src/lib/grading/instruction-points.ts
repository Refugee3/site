import { MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
import { truncateChars } from "@/lib/grading/text";
import type { NewKeyItem } from "@/lib/types";

// The points and parts a teacher's instructions give ("Question 3 is worth 10 points, split into 4 parts", "Q2: 2 points for
// the setup, 2 for the work, 1 for the answer"), read by code and applied to the key the AI read. The AI is asked to follow the
// instructions itself; this makes sure the result matches them even when it doesn't (smaller local models often ignore them):
// a question the AI left whole is split into the parts asked for, and the parts get the points asked for.

export interface PointsRule {
  /** The question it is about, normalized ("3", "4b"). */
  question: string;
  /** The whole question's points. */
  totalPoints: number | null;
  /** How many parts it splits into. */
  parts: number | null;
  /** Points per part, in order, when the teacher named them ("2 for the setup, 1 for the answer"). */
  partPoints: Array<{ points: number; name: string }>;
  /** "each part is worth 2". */
  eachPoints: number | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM = String.raw`(\d+(?:\.\d+)?|${Object.keys(NUMBER_WORDS).join("|")})`;
const UNIT = String.raw`(?:points?|pts?\.?|marks?)`;
const PARTS = String.raw`(?:sub-?\s?)?(?:parts?|sections?|segments?|pieces|steps|sub-?questions?|components?|categories)`;
const QUESTION = String.raw`(?:questions?|q|problems?|prob\.?|exercises?|number|no\.?|#)\s*(\d{1,3}(?:\s?\(?[a-z]\)?)?)\b`;

function num(text: string): number | null {
  const lower = text.toLowerCase();
  const value = NUMBER_WORDS[lower] ?? Number(lower);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "Q3", "3(b)", "3 b" → "3b". */
export function normLabel(label: string): string {
  return label.toLowerCase().replace(/^(?:question|q|problem|#)\s*/, "").replace(/[\s().:\-]/g, "");
}

/** The points rules the instructions state, one per question named, in order. */
export function pointsRules(instructions: string): PointsRule[] {
  const rules = new Map<string, PointsRule>();
  // Sentences; a decimal point ("2.5 points") isn't a sentence end.
  for (const sentence of instructions.split(/\n+|;|(?<!\d)\.(?!\d)/)) {
    const q = new RegExp(QUESTION, "i").exec(sentence) ?? /^\s*(\d{1,3}[a-z]?)\s*[:)\-]/i.exec(sentence)
      ?? /^\s*(\d{1,3}[a-z]?)\s+(?:is|has|should|gets|will)\b/i.exec(sentence);
    if (!q) continue;
    const question = normLabel(q[1]);
    const rest = sentence.slice(q.index + q[0].length);

    // "2 points for the setup, 2 for the work, 1 for the final answer"
    const partPoints: PointsRule["partPoints"] = [];
    const partRe = new RegExp(String.raw`${NUM}\s*${UNIT}?\s+(?:for|on|towards?)\s+(?:the\s+|a\s+|an\s+)?([^,;]+?)(?=\s*(?:,|;|\band\b\s+${NUM}|$))`, "gi");
    let leftover = rest;
    for (const m of rest.matchAll(partRe)) {
      const points = num(m[1]);
      if (points === null) continue;
      partPoints.push({ points, name: m[2].trim().replace(/^(?:and|&)\s+/i, "") });
      leftover = leftover.replace(m[0], " ");
    }

    const each = new RegExp(String.raw`(?:each|every|per)\s+(?:${PARTS}\s+)?(?:is\s+|are\s+)?(?:worth\s+)?${NUM}\s*${UNIT}|${NUM}\s*${UNIT}\s+(?:each|apiece|per\s+${PARTS})`, "i").exec(leftover);
    const eachPoints = each ? num(each[1] ?? each[2]) : null;
    if (each) leftover = leftover.replace(each[0], " ");

    const total = new RegExp(String.raw`${NUM}\s*${UNIT}`, "i").exec(leftover);
    const totalPoints = total ? num(total[1]) : null;

    const count = new RegExp(String.raw`(?:into|has|have|with|in|of)\s+${NUM}\s+${PARTS}|${NUM}\s*${PARTS}`, "i").exec(rest);
    const parts = count ? num(count[1] ?? count[2]) : null;

    if (totalPoints === null && partPoints.length === 0 && eachPoints === null && parts === null) continue;
    rules.set(question, {
      question,
      totalPoints,
      parts: parts !== null && Number.isInteger(parts) && parts >= 1 && parts <= 26 ? parts : null,
      partPoints,
      eachPoints,
    });
  }
  return [...rules.values()];
}

/** How many parts a rule asks for, if it says. */
function wantedParts(rule: PointsRule): number | null {
  if (rule.partPoints.length > 1) return rule.partPoints.length;
  if (rule.parts !== null) return rule.parts;
  if (rule.totalPoints !== null && rule.eachPoints !== null) {
    const n = rule.totalPoints / rule.eachPoints;
    return Number.isInteger(n) && n >= 1 && n <= 26 ? n : null;
  }
  return null;
}

function toCenti(points: number): number {
  return Math.min(Math.max(Math.round(points * 100), 1), MAX_ITEM_POINTS_CENTI);
}

/** `total` split into `n` shares that add up exactly (whole centipoints, the remainder on the first ones). */
function shares(totalCenti: number, n: number): number[] {
  const base = Math.floor(totalCenti / n);
  return Array.from({ length: n }, (_, i) => Math.max(1, base + (i < totalCenti - base * n ? 1 : 0)));
}

/** The points each of `n` parts gets under the rule, or null when it doesn't say. */
function partCenti(rule: PointsRule, n: number): number[] | null {
  if (rule.partPoints.length === n) return rule.partPoints.map((p) => toCenti(p.points));
  if (rule.eachPoints !== null) return Array.from({ length: n }, () => toCenti(rule.eachPoints!));
  if (rule.totalPoints !== null) return shares(toCenti(rule.totalPoints), n);
  return null;
}

const PART_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Applies the instructions' points rules to the items the AI read. Returns the items (split and re-pointed where the rules
 * say) and a note per change or per rule that couldn't be applied, for the AI notes the teacher sees.
 */
export function applyPointsRules(items: NewKeyItem[], instructions: string): { items: NewKeyItem[]; notes: string[] } {
  const rules = pointsRules(instructions);
  if (rules.length === 0) return { items, notes: [] };
  let out = [...items];
  const notes: string[] = [];

  for (const rule of rules) {
    const matching = out.flatMap((item, index) => {
      const label = normLabel(item.label);
      const group = normLabel(item.groupLabel);
      return label === rule.question || (group !== "" && group === rule.question) ? [index] : [];
    });
    if (matching.length === 0) {
      notes.push(`Your instructions give points for question ${rule.question}, but the key has no question ${rule.question}.`);
      continue;
    }
    const wanted = wantedParts(rule);

    if (wanted !== null && wanted > 1 && matching.length === 1) {
      const index = matching[0];
      const parts = splitItem(out[index], wanted, rule);
      out = [...out.slice(0, index), ...parts, ...out.slice(index + 1)];
      notes.push(`Split question ${out[index].groupLabel} into ${wanted} parts with your points, as your instructions say.`);
      continue;
    }
    if (wanted !== null && wanted !== matching.length) {
      notes.push(
        `Your instructions split question ${rule.question} into ${wanted} parts, but the key shows ${matching.length}. Check its parts and points.`,
      );
      continue;
    }
    const centi = partCenti(rule, matching.length);
    if (centi === null) continue;
    if (matching.some((index, i) => out[index].pointsCenti !== centi[i])) {
      out = out.map((item, index) => {
        const at = matching.indexOf(index);
        return at === -1 ? item : { ...item, pointsCenti: centi[at] };
      });
      notes.push(`Set the points for question ${rule.question} from your instructions.`);
    }
  }
  return { items: out, notes };
}

/** One item as `n` parts ("3" → "3a", "3b", "3c"), with the rule's part names and points. */
function splitItem(item: NewKeyItem, n: number, rule: PointsRule): NewKeyItem[] {
  const group = item.label;
  const centi = partCenti(rule, n) ?? shares(item.pointsCenti, n);
  const partLabel = (i: number) => (/\d$/.test(item.label) ? `${item.label}${PART_LETTERS[i]}` : `${item.label}.${i + 1}`);
  return Array.from({ length: n }, (_, i): NewKeyItem => {
    const name = rule.partPoints.length === n ? rule.partPoints[i].name : null;
    const what = name ? `part ${PART_LETTERS[i]}: ${name}` : `part ${PART_LETTERS[i]} of ${n}`;
    const criteria = [`Grade only this part of question ${group} (${what}).`, item.gradingCriteria].filter((c) => c !== "").join(" ");
    return {
      ...item,
      label: truncateChars(partLabel(i), 40),
      groupLabel: truncateChars(group, 40),
      prompt: truncateChars(item.prompt ? `${item.prompt} (${what})` : `Question ${group}, ${what}`, 1000),
      gradingCriteria: truncateChars(criteria, 1000),
      pointsCenti: centi[i],
      partialCredit: true,
      aiNote: "",
    };
  });
}
