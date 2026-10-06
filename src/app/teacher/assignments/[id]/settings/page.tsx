import { connection } from "next/server";
import { updateAssignmentAction } from "@/actions/assignments";
import { AssignmentForm } from "@/components/teacher/assignment-form";
import { DangerZone } from "@/components/teacher/danger-zone";
import { Card } from "@/components/ui/card";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { getSettingsView } from "@/lib/services/views";
import type { AssignmentFormInput, SettingsView } from "@/lib/types";

export default async function SettingsPage(props: PageProps<"/teacher/assignments/[id]/settings">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const view = getSettingsView(assignment);
  const defaults: AssignmentFormInput = {
    title: assignment.title,
    instructions: assignment.instructions,
    gradingMode: assignment.gradingMode,
    accuracyWeight: assignment.accuracyWeight,
    sectionsText: view.sectionsText,
    maxSubmissions: assignment.maxSubmissions,
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card title="Settings">
        <AssignmentForm mode="edit" action={updateAssignmentAction.bind(null, assignment.id)} defaults={defaults} />
      </Card>
      <Card title="AI usage">
        <Usage usage={view.usage} />
      </Card>
      <Card title="Danger zone">
        <DangerZone assignmentId={assignment.id} title={assignment.title} />
      </Card>
    </div>
  );
}

const tokens = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Usage({ usage }: { usage: SettingsView["usage"] }) {
  const rows: Array<[string, string]> = [
    ["Papers read by the AI", tokens.format(usage.papers)],
    ["Input tokens", tokens.format(usage.inputTokens)],
    ["Cached input tokens read", tokens.format(usage.cacheReadTokens)],
    ["Cached input tokens written", tokens.format(usage.cacheWriteTokens)],
    ["Output tokens (including thinking)", tokens.format(usage.outputTokens)],
    ["Estimated cost", usage.estimatedCostUsd === null ? "Not available for this model" : dollars.format(usage.estimatedCostUsd)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">
        Includes reading the answer key. The key is cached between papers, so most papers should show cached reads; if
        they don&apos;t, caching has stopped working and each paper costs more.
      </p>
    </div>
  );
}
