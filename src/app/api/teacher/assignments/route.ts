import type { NextRequest } from "next/server";
import * as z from "zod";
import { requireRouteTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { assertSameOrigin, readUploadForm, toErrorResponse } from "@/lib/http/request";
import { parseInput } from "@/lib/http/validation";
import { createAssignmentFromKey } from "@/lib/services/assignments";
import { ASSIGNMENT_KINDS } from "@/lib/types";

const KindSchema = z.enum(ASSIGNMENT_KINDS, "Choose Homework or Quiz.");

/**
 * A new homework or quiz started from its answer key (`?kind=homework|quiz`, the key's files merged in order), dropped on the
 * dashboard, with the teacher's optional instructions for reading it (`instructions` form field): the assignment is created ("Untitled …" until the AI suggests a title), the key stored and queued for reading.
 * Answers 201 with the workspace to open. A key that can't be stored creates nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const kind = parseInput(KindSchema, req.nextUrl.searchParams.get("kind") ?? "homework");
    const form = await readUploadForm(req, "file", getConfig().maxUploadFiles);
    const assignment = await createAssignmentFromKey(teacher.id, kind, form.files, form.text("instructions"));
    return Response.json(
      { assignmentId: assignment.id, workspaceUrl: `/teacher/assignments/${assignment.id}` },
      { status: 201 },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}
