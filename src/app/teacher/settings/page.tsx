import type { Metadata } from "next";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { AiModelCard } from "@/components/teacher/ai-model-card";
import { ApiKeyForm } from "@/components/teacher/api-key-form";
import { GraderCard } from "@/components/teacher/grader-card";
import { PreferencesForm } from "@/components/teacher/preferences-form";
import { StudentUploadsSwitch } from "@/components/teacher/student-uploads-switch";
import { Card } from "@/components/ui/card";
import { requireTeacher } from "@/lib/auth/dal";
import { getTeacherSettingsView } from "@/lib/services/views";

export const metadata: Metadata = { title: "Settings" };

/** While the hosted agent is being set up, the page checks every 2 s (setup takes seconds; at most 2 min). */
const SETUP_POLL_MS = 2000;
const SETUP_POLL_MAX_MS = 120_000;

/** Server-wide settings (the API key, the AI model, the grader, student uploads) and the teacher's own grading preferences. */
export default async function TeacherSettingsPage() {
  await connection();
  const teacher = await requireTeacher();
  const view = getTeacherSettingsView(teacher);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card title="Anthropic API key">
        <ApiKeyForm apiKey={view.apiKey} aiMode={view.aiMode} model={view.aiModel} keyIssue={view.worker?.keyIssue ?? null} />
      </Card>
      <Card title="AI model">
        <AiModelCard model={view.aiModel} />
      </Card>
      <Card title="Grader">
        <GraderCard engine={view.grader.engine} aiMode={view.aiMode} agent={view.grader.agent} />
      </Card>
      <Card title="Student submissions">
        <StudentUploadsSwitch enabled={view.studentsCanUpload} openAssignmentCount={view.openAssignmentCount} />
      </Card>
      <Card title="Grading preferences">
        <PreferencesForm preferences={view.gradingPreferences} />
      </Card>
      <AutoRefresh intervalMs={view.grader.agent?.state === "setting_up" ? SETUP_POLL_MS : null} maxDurationMs={SETUP_POLL_MAX_MS} />
    </div>
  );
}
