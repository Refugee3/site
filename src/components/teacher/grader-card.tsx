"use client";

import { useOptimistic, useState } from "react";
import { setGradingEngineAction, setUpHostedAgentAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { Spinner } from "@/components/ui/spinner";
import type { GradingEngineChoice, HostedAgentStatusView } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface GraderCardProps {
  engine: GradingEngineChoice;
  aiMode: "claude" | "fake";
  /** The hosted agent's setup for the key in use; null in AI_MODE=fake or without a usable key. */
  agent: HostedAgentStatusView | null;
}

interface EngineOption {
  value: GradingEngineChoice;
  label: string;
  badge: { text: string; tone: "info" | "neutral" };
  hint: string;
}

const ENGINE_OPTIONS: EngineOption[] = [
  {
    value: "direct",
    label: "Direct API",
    badge: { text: "Recommended", tone: "info" },
    hint: "Sends each paper to Claude in a single request. Faster and cheaper, and right for most homework.",
  },
  {
    value: "agent",
    label: "Anthropic-hosted agent",
    badge: { text: "Optional", tone: "neutral" },
    hint: "Best for very hard-to-read papers: Claude works through each paper in a private workspace on Anthropic's servers and "
      + "can enlarge, crop or rotate a page. Slower (a few minutes per paper) and more expensive: it takes more AI turns per "
      + "paper, plus $0.08 per hour of agent time.",
  },
];

/** Settings → Grader: which engine sends papers, answer keys and scans to Claude, and whether the hosted agent is set up. */
export function GraderCard({ engine, aiMode, agent }: GraderCardProps) {
  const runner = useActionRunner();
  // The choice moves at once; it settles on the stored value when the action and refresh finish (or fail).
  const [shownEngine, setShownEngine] = useOptimistic(engine);
  const [saved, setSaved] = useState<string | null>(null);

  function choose(next: GradingEngineChoice) {
    setSaved(null);
    runner.run(() => {
      setShownEngine(next);
      return setGradingEngineAction(next);
    }, (result) => setSaved(result.message ?? null));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        How papers, answer keys and scans are sent to Claude. Direct API is the default; the hosted agent is optional. Both
        use the API key and the AI model above and are billed to the same Anthropic account.
      </p>
      <fieldset disabled={runner.pending} className="flex min-w-0 flex-col gap-2">
        <legend className="sr-only">Grading engine</legend>
        {ENGINE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer gap-3 rounded-lg border border-line-strong bg-surface p-3 has-checked:border-brand-600 has-checked:bg-brand-50"
          >
            <input
              type="radio"
              name="grading-engine"
              value={option.value}
              checked={shownEngine === option.value}
              onChange={() => choose(option.value)}
              className="mt-0.5 size-5 shrink-0 accent-brand-600"
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {option.label}
                <Badge tone={option.badge.tone}>{option.badge.text}</Badge>
                {runner.pending && shownEngine === option.value && <Spinner className="size-4" />}
              </span>
              <span className="text-sm text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p role="status" className="text-sm text-success-800 empty:hidden">
        {saved}
      </p>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}

      {shownEngine === "agent" ? (
        <HostedAgentStatus aiMode={aiMode} agent={agent} />
      ) : (
        <p className="text-sm text-muted">
          The hosted agent isn&apos;t used, and nothing is set up for it until you choose it. Anything set up for it earlier
          stays in your Anthropic workspace, unused.
        </p>
      )}

      <p className="text-xs text-muted">
        Papers are processed on Anthropic&apos;s servers with either engine. The hosted agent deletes each paper&apos;s upload and
        agent session from Anthropic as soon as the paper is done. Claude Managed Agents isn&apos;t eligible for Zero Data
        Retention (ZDR); if your school requires ZDR, choose Direct API under a ZDR agreement.
      </p>
    </div>
  );
}

/** Whether the hosted agent is set up for the key in use, with "Set up now" / "Set up again". */
function HostedAgentStatus({ aiMode, agent }: Pick<GraderCardProps, "aiMode" | "agent">) {
  const runner = useActionRunner();
  const [ready, setReady] = useState<string | null>(null);

  function setUp() {
    setReady(null);
    runner.run(setUpHostedAgentAction, (result) => setReady(result.message ?? null));
  }

  const setUpButton = (label: string) => (
    <Button variant="secondary" size="sm" disabled={runner.pending} aria-busy={runner.pending || undefined} onClick={setUp}>
      {runner.pending && <Spinner className="size-4" />}
      {runner.pending ? "Setting up…" : label}
    </Button>
  );

  if (aiMode === "fake") {
    return (
      <p className="text-sm text-muted">
        Practice mode (AI_MODE=fake): neither engine runs, so nothing is set up. Your choice is used once the server runs with
        AI_MODE=claude.
      </p>
    );
  }
  if (agent === null) {
    return <p className="text-sm text-muted">Add an API key above. The hosted agent is set up as soon as a key is saved.</p>;
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {agent.state === "not_set_up" && (
        <>
          <p className="flex flex-wrap items-center gap-2">
            Hosted agent: <Badge tone="neutral">Not set up yet</Badge>
          </p>
          <p className="text-muted">It&apos;s set up automatically before the next paper is graded.</p>
          <div>{setUpButton("Set up now")}</div>
        </>
      )}
      {agent.state === "setting_up" && (
        <p className="flex items-center gap-2">
          <Spinner className="size-4" />
          Hosted agent: setting up… This takes a few seconds.
        </p>
      )}
      {agent.state === "ready" && (
        <>
          <p className="flex flex-wrap items-center gap-2">
            Hosted agent: <Badge tone="success">Ready</Badge>
          </p>
          {agent.checkedAt !== null && (
            <p className="text-muted">
              Checked <LocalTime ms={agent.checkedAt} />.
            </p>
          )}
        </>
      )}
      {agent.state === "error" && (
        <>
          <Alert tone="danger" title="The hosted agent couldn't be set up">
            {agent.error}
          </Alert>
          <div>{setUpButton("Set up again")}</div>
          <p className="text-muted">Or choose Direct API above to keep grading.</p>
        </>
      )}
      <p role="status" className="text-success-800 empty:hidden">
        {ready}
      </p>
      {/* A failed setup is stored too, so after the refresh the alert above already says why. */}
      {runner.error && runner.error !== agent.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}
