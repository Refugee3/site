import "server-only";
import { DOCUMENT_CONTEXT, PDF_BYTE_BUDGET, PDF_TOO_LARGE } from "../claude";
import { AiError } from "../errors";
import type { AiCallMeta, CallOptions, Grader } from "../grader";
import { itemRefs, renderGradingContext, renderGuidance, renderScanContext } from "../prompts";
import { type GradingOutput, GradingOutputSchema, KeyExtractionSchema, type ScanPages, ScanPagesSchema } from "../schemas";
import { AGENT_ROLES, type AgentEngineConfig, MOUNT, roleModel } from "./definitions";
import { teacherMessageFor } from "./errors";
import { agentExtractionTask, agentGradingTask, agentScanTask } from "./prompts";
import { agentProcessSlot, ensureProvisioned, type ProvisionDeps, type ProvisionedAgents } from "./provision";
import {
  type AgentTaskResult,
  type AgentTaskSpec,
  runAgentTask,
  SWEEP_INTERVAL_MS,
  sweepCutoff,
  sweepStaleSessions,
  type UserContentBlock,
} from "./session";

// The Grader backed by the Anthropic-hosted agent: the same inputs, outputs and errors as the direct path, with
// each task run as one Managed Agents session.

export interface AgentGraderDeps extends ProvisionDeps {
  /** Called once, after the first task that succeeds (confirms a saved key, like confirmKeyOnSuccess). */
  onFirstSuccess?: () => void;
  /**
   * The model chosen in Settings now, read when each task starts (default: cfg.model). A task of a job that started
   * before the model was changed then sets up and uses the same agents as the new jobs, instead of switching the
   * agents back to the old model and forth again.
   */
  currentModel?: () => AgentEngineConfig["model"];
}

export function createAgentGrader(d: AgentGraderDeps): Grader {
  const now = d.now ?? Date.now;
  let confirmed = false;

  async function run<T>(spec: Omit<AgentTaskSpec<T>, "budgetCents">, o: CallOptions): Promise<{ output: T; meta: AiCallMeta }> {
    // Every step of the task (setup, session, the model it is reported under) uses the definitions read here.
    const task: ProvisionDeps = d.currentModel ? { ...d, cfg: { ...d.cfg, model: d.currentModel() } } : d;
    const provisioned = await ensureProvisioned(task, { signal: o.signal });
    // A call asking for more than the configured max tokens is the retry after a cap: it gets double the budget.
    const budgetCents = d.cfg.budgetCents[spec.role] * ((o.maxTokens ?? d.cfg.maxTokens) > d.cfg.maxTokens ? 2 : 1);
    sweepIfDue(provisioned);
    let result: AgentTaskResult<T>;
    try {
      result = await runAgentTask({
        port: d.port,
        cfg: task.cfg,
        provisioned,
        reprovision: () => ensureProvisioned(task, { force: true, signal: o.signal }),
        now: d.now,
      }, { ...spec, budgetCents }, { signal: o.signal });
    } catch (e) {
      if (e instanceof AiError && (e.code === "auth" || e.code === "agent_unavailable")) recordSessionError(e);
      throw e;
    }
    confirmOnce();
    const model = roleModel(task.cfg, spec.role);
    return {
      output: result.output,
      meta: {
        requestedModel: model,
        servedModel: model,
        fallbackUsed: false,
        stopReason: "end_turn",
        usage: result.usage,
        durationMs: result.durationMs,
        agent: result.cost,
      },
    };
  }

  /** At most once per SWEEP_INTERVAL_MS per process (the first task after start included), never when sessions are kept. */
  function sweepIfDue(provisioned: ProvisionedAgents): void {
    if (d.cfg.keepSessions) return;
    const slot = agentProcessSlot();
    const t = now();
    if (t - slot.lastSweepAt < SWEEP_INTERVAL_MS) return;
    slot.lastSweepAt = t;
    void sweepStaleSessions({
      port: d.port,
      agentIds: AGENT_ROLES.map((role) => provisioned.agents[role].id),
      createdBefore: sweepCutoff(t, d.cfg),
      active: slot.active,
    });
  }

  /** Settings shows why the hosted agent stopped working (the stored ids are kept). */
  function recordSessionError(err: AiError): void {
    try {
      d.store.saveError(teacherMessageFor(err));
    } catch (e) {
      console.error("[agent] couldn't record the hosted agent's error", e);
    }
  }

  function confirmOnce(): void {
    if (confirmed || !d.onFirstSuccess) return;
    confirmed = true;
    try {
      d.onFirstSuccess();
    } catch (e) {
      // Only the badge in Settings depends on it; the answer the call paid for is kept.
      console.error("[agent] couldn't mark the saved API key as confirmed", e);
    }
  }

  return {
    mode: "claude",
    engine: "agent",
    async extractKey(input, o = {}) {
      if (input.keyPdf.byteLength > PDF_BYTE_BUDGET) throw new AiError("request_too_large", PDF_TOO_LARGE.key, { retryable: false });
      return run({
        role: "extract",
        title: "PDF Auto-Grader: read an answer key",
        files: [{ uploadName: "answer-key.pdf", mount: MOUNT.answerKey, bytes: input.keyPdf }],
        content: ([keyId]) => [
          document("ANSWER KEY", keyId),
          { type: "text", text: agentExtractionTask(input.assignmentTitle, input.teacherNotes, input.pageCount) },
        ],
        schema: KeyExtractionSchema,
      }, o);
    },
    async gradeSubmission(input, o = {}) {
      const studentBytes = input.studentPdf.byteLength;
      if (studentBytes > PDF_BYTE_BUDGET) throw new AiError("request_too_large", PDF_TOO_LARGE.student, { retryable: false });
      const keyPdf = input.keyPdf !== null && input.keyPdf.byteLength + studentBytes <= PDF_BYTE_BUDGET ? input.keyPdf : null;
      const refs = itemRefs(input.items.length);
      const guidance = renderGuidance(input.guidance, input.items);
      const context = renderGradingContext({
        assignment: input.assignment, teacherNotes: input.teacherNotes, sections: input.sections, items: input.items,
      });
      const { output, meta } = await run({
        role: "grade",
        title: "PDF Auto-Grader: grade one paper",
        files: [
          ...(keyPdf ? [{ uploadName: "answer-key.pdf", mount: MOUNT.answerKey, bytes: keyPdf }] : []),
          { uploadName: "student-submission.pdf", mount: MOUNT.student, bytes: input.studentPdf },
        ],
        content: (fileIds) => [
          ...(keyPdf ? [document("TEACHER ANSWER KEY", fileIds[0], DOCUMENT_CONTEXT.teacherKey)] : []),
          { type: "text", text: context },
          ...(guidance === "" ? [] : [{ type: "text" as const, text: guidance }]),
          document("STUDENT SUBMISSION", fileIds[fileIds.length - 1], DOCUMENT_CONTEXT.student),
          { type: "text", text: agentGradingTask(input.studentPageCount, refs, keyPdf !== null) },
        ],
        schema: GradingOutputSchema,
        check: (out) => refProblems(out, refs),
      }, o);
      return { output, refs, keyPdfIncluded: keyPdf !== null, meta };
    },
    async readScanPages(input, o = {}) {
      if (input.chunkPdf.byteLength > PDF_BYTE_BUDGET) throw new AiError("request_too_large", PDF_TOO_LARGE.scan, { retryable: false });
      const lastPage = input.firstPage + input.chunkPageCount - 1;
      return run({
        role: "scan",
        title: `PDF Auto-Grader: read scanned pages ${input.firstPage}–${lastPage}`,
        files: [{ uploadName: "scanned-pages.pdf", mount: MOUNT.scan, bytes: input.chunkPdf }],
        content: ([scanId]) => [
          { type: "text", text: renderScanContext(input) },
          document("SCANNED PAGES", scanId, DOCUMENT_CONTEXT.scan),
          { type: "text", text: agentScanTask(input.firstPage, input.chunkPageCount, input.totalPages, input.previousPage) },
        ],
        schema: ScanPagesSchema,
        check: (out) => pageProblems(out, input.chunkPageCount),
      }, o);
    },
  };
}

function document(title: string, fileId: string, context?: string): UserContentBlock {
  return { type: "document", title, ...(context ? { context } : {}), source: { type: "file", file_id: fileId } };
}

/** The grading must have exactly one entry per ref, in key order. */
function refProblems(output: GradingOutput, refs: string[]): string[] {
  const got = output.items.map((item) => item.ref);
  if (got.length === refs.length && got.every((ref, i) => ref === refs[i])) return [];
  const n = refs.length;
  const problems = [n === 0 ? "items must be empty" : `items must have exactly ${n} entries, with ref ${refs[0]} to ${refs[n - 1]} in this order`];
  const missing = refs.filter((ref) => !got.includes(ref));
  const extra = got.filter((ref) => !refs.includes(ref));
  const misplaced = got.findIndex((ref, i) => i < n && ref !== refs[i]);
  if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`not in the key: ${extra.join(", ")}`);
  if (misplaced !== -1) problems.push(`entry ${misplaced + 1} has ref "${got[misplaced]}" where ${refs[misplaced]} was expected`);
  return problems;
}

/** The scan reading must describe every page of the chunk, chunk_page 1…N in order. */
function pageProblems(output: ScanPages, n: number): string[] {
  const headline = `pages must have exactly ${n} entries, with chunk_page 1 to ${n} in this order`;
  if (output.pages.length !== n) return [headline];
  const misplaced = output.pages.findIndex((page, i) => page.chunk_page !== i + 1);
  if (misplaced === -1) return [];
  return [headline, `entry ${misplaced + 1} has chunk_page ${output.pages[misplaced].chunk_page} where ${misplaced + 1} was expected`];
}
