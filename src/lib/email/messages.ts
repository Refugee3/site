import { formatPercent } from "@/lib/format";

// The notification emails' wording (pure). Each has a subject, a plain-text body and the same body as simple HTML.

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const FOOTER = "You get these emails from DragonGrader. To stop them, open Settings and turn off \"Email me when grading is done\".";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Paragraphs → text and HTML; a paragraph may end with a link. */
function render(subject: string, paragraphs: Array<{ text: string; link?: { label: string; url: string } }>): EmailContent {
  const text = [...paragraphs.map((p) => (p.link ? `${p.text}\n${p.link.label}: ${p.link.url}` : p.text)), "--", FOOTER].join("\n\n");
  const body = paragraphs.map((p) => {
    const link = p.link ? ` <a href="${escapeHtml(p.link.url)}" style="color:#07294d">${escapeHtml(p.link.label)}</a>` : "";
    return `<p style="margin:0 0 14px">${escapeHtml(p.text)}${link}</p>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f2;font-family:Segoe UI,Arial,sans-serif;color:#1d2125;font-size:15px;line-height:1.5">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e0ddd4">`
    + `<div style="background:#07294d;color:#ffffff;padding:12px 20px;font-family:Palatino Linotype,Georgia,serif;font-size:18px"><b>Dragon</b>Grader</div>`
    + `<div style="padding:20px">${body}</div>`
    + `<div style="padding:12px 20px;border-top:1px solid #e0ddd4;color:#595d63;font-size:12px">${escapeHtml(FOOTER)}</div>`
    + `</div></body></html>`;
  return { subject, text, html };
}

export interface GradingDoneFacts {
  title: string;
  /** Papers graded since the last email (including those waiting for a check). */
  graded: number;
  /** Of the assignment's current papers: waiting for the teacher's check, and couldn't be graded. */
  toCheck: number;
  failed: number;
  /** The class average over the current graded papers, tenths of a percent. */
  averageTenths: number | null;
  /** Links, or null when DragonGrader's address isn't known. */
  resultsUrl: string | null;
  checkUrl: string | null;
}

export function gradingDoneEmail(f: GradingDoneFacts): EmailContent {
  const subject = `Graded: ${f.title}${f.toCheck > 0 ? ` (${f.toCheck} to check)` : ""}`;
  const paragraphs: Array<{ text: string; link?: { label: string; url: string } }> = [
    { text: `${plural(f.graded, "paper")} in ${f.title} ${f.graded === 1 ? "was" : "were"} graded.` },
  ];
  if (f.averageTenths !== null) paragraphs.push({ text: `Class average: ${formatPercent(f.averageTenths)}.` });
  if (f.toCheck > 0) {
    paragraphs.push({
      text: `${plural(f.toCheck, "paper needs", "papers need")} your check: the AI wasn't sure about something on ${f.toCheck === 1 ? "it" : "them"}.`,
      ...(f.checkUrl ? { link: { label: "Check them", url: f.checkUrl } } : {}),
    });
  }
  if (f.failed > 0) paragraphs.push({ text: `${plural(f.failed, "paper")} couldn't be graded. Open the assignment to retry or grade by hand.` });
  paragraphs.push(f.resultsUrl
    ? { text: "The grades are ready.", link: { label: "Open the results", url: f.resultsUrl } }
    : { text: "Open DragonGrader to see the results." });
  return render(subject, paragraphs);
}

export interface KeyReadyFacts {
  title: string;
  questions: number;
  keyUrl: string | null;
}

export function keyReadyEmail(f: KeyReadyFacts): EmailContent {
  return render(`Answer key ready to check: ${f.title}`, [
    { text: `The AI has read the answer key for ${f.title} (${plural(f.questions, "question")}).` },
    {
      text: "Check it and approve it; papers are graded once the key is approved.",
      ...(f.keyUrl ? { link: { label: "Check the key", url: f.keyUrl } } : {}),
    },
  ]);
}

export function testEmail(publicUrl: string | null): EmailContent {
  return render("DragonGrader test email", [
    { text: "Email from DragonGrader works. You'll get an email when grading is done and when an answer key is ready to check." },
    ...(publicUrl ? [{ text: "Links in these emails open", link: { label: publicUrl, url: publicUrl } }] : []),
  ]);
}
