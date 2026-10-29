import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { AiModelCard } from "@/components/teacher/ai-model-card";
import { ApiKeyForm } from "@/components/teacher/api-key-form";
import { EmailSettings } from "@/components/teacher/email-settings";
import { GraderCard } from "@/components/teacher/grader-card";
import { PreferencesForm } from "@/components/teacher/preferences-form";
import { Card } from "@/components/ui/card";
import { testOllamaConnection } from "@/lib/ai/ollama/connection";
import { requireTeacher } from "@/lib/auth/dal";
import { getNotifyByEmail } from "@/lib/db/repos/email";
import { getEmailSettingsView } from "@/lib/email/settings";
import { getOllamaSpeedView, getTeacherSettingsView } from "@/lib/services/views";

export const metadata: Metadata = { title: "Settings" };

/** While the hosted agent is being set up, the page checks every 2 s (setup takes seconds; at most 2 min). */
const SETUP_POLL_MS = 2000;
const SETUP_POLL_MAX_MS = 120_000;

/** Server-wide settings (the API key, the AI model, the grader, Ollama) and the teacher's own grading preferences. */
export default async function TeacherSettingsPage() {
  await connection();
  const teacher = await requireTeacher();
  const view = getTeacherSettingsView(teacher);
  // With Ollama chosen, the page looks at the saved address (≤ 5 s) so the model list is filled in.
  const ollamaCheck = view.grader.engine === "ollama" ? await testOllamaConnection(view.grader.ollama) : null;
  // This page's own address, as the browser reached it: the suggestion for the links in emails.
  const h = await headers();
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost:3000";
  const protocol = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card title="Anthropic API key">
        <ApiKeyForm
          apiKey={view.apiKey}
          aiMode={view.aiMode}
          model={view.aiModel}
          keyIssue={view.worker?.keyIssue ?? null}
          engine={view.grader.engine}
        />
      </Card>
      <Card title="AI model">
        <AiModelCard model={view.aiModel} engine={view.grader.engine} />
      </Card>
      <Card title="Grader">
        <GraderCard
          engine={view.grader.engine}
          aiMode={view.aiMode}
          agent={view.grader.agent}
          ollama={view.grader.ollama}
          ollamaCheck={ollamaCheck}
          ollamaSpeed={getOllamaSpeedView()}
        />
      </Card>
      <Card title="Email when grading is done">
        <EmailSettings
          view={getEmailSettingsView()}
          teacherEmail={teacher.email}
          notify={getNotifyByEmail(teacher.id)}
          suggestedUrl={`${protocol}://${host}`}
        />
      </Card>
      <Card title="Grading preferences">
        <PreferencesForm preferences={view.gradingPreferences} />
      </Card>
      <AutoRefresh intervalMs={view.grader.agent?.state === "setting_up" ? SETUP_POLL_MS : null} maxDurationMs={SETUP_POLL_MAX_MS} />
    </div>
  );
}
