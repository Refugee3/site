import type { Metadata } from "next";
import { connection } from "next/server";
import { ApiKeyForm } from "@/components/teacher/api-key-form";
import { PreferencesForm } from "@/components/teacher/preferences-form";
import { StudentUploadsSwitch } from "@/components/teacher/student-uploads-switch";
import { Card } from "@/components/ui/card";
import { requireTeacher } from "@/lib/auth/dal";
import { getTeacherSettingsView } from "@/lib/services/views";

export const metadata: Metadata = { title: "Settings" };

/** Server-wide settings (the API key, student uploads) and the teacher's own grading preferences. */
export default async function TeacherSettingsPage() {
  await connection();
  const teacher = await requireTeacher();
  const view = getTeacherSettingsView(teacher);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card title="Anthropic API key">
        <ApiKeyForm apiKey={view.apiKey} aiMode={view.aiMode} model={view.model} keyIssue={view.worker?.keyIssue ?? null} />
      </Card>
      <Card title="Student submissions">
        <StudentUploadsSwitch enabled={view.studentsCanUpload} />
      </Card>
      <Card title="Grading preferences">
        <PreferencesForm preferences={view.gradingPreferences} />
      </Card>
    </div>
  );
}
