import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { deleteExpiredSessions, deleteSession, findSessionTeacher, insertSession } from "@/lib/db/repos/sessions";
import { countTeachers, findTeacherAuthByEmail, getTeacher, insertTeacher } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
});

describe("teachers", () => {
  it("inserts and reads teachers", () => {
    expect(countTeachers()).toBe(0);
    const teacher = insertTeacher({ email: "ms.rivera@school.org", displayName: "Ms. Rivera", passwordHash: "scrypt$hash" });

    expect(teacher).toEqual({ id: expect.any(String), email: "ms.rivera@school.org", displayName: "Ms. Rivera", createdAt: T0 });
    expect(countTeachers()).toBe(1);
    expect(getTeacher(teacher.id)).toEqual(teacher);
    expect(getTeacher("missing")).toBeNull();
  });

  it("finds the password hash by email, case-insensitively", () => {
    const teacher = insertTeacher({ email: "ms.rivera@school.org", displayName: "Ms. Rivera", passwordHash: "scrypt$hash" });
    expect(findTeacherAuthByEmail("MS.Rivera@School.org")).toEqual({ teacher, passwordHash: "scrypt$hash" });
    expect(findTeacherAuthByEmail("nobody@school.org")).toBeNull();
  });

  it("throws AppError conflict for an email that differs only in case", () => {
    insertTeacher({ email: "ms.rivera@school.org", displayName: "A", passwordHash: "h" });
    const again = () => insertTeacher({ email: "MS.RIVERA@school.org", displayName: "B", passwordHash: "h" });
    expect(again).toThrow(AppError);
    expect(again).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(countTeachers()).toBe(1);
  });
});

describe("sessions", () => {
  it("finds the teacher of an unexpired session only", () => {
    const teacher = insertTeacher({ email: "a@school.org", displayName: "A", passwordHash: "h" });
    insertSession({ tokenHash: "live", teacherId: teacher.id, expiresAt: T0 + 1000 });

    expect(findSessionTeacher("live", T0)).toEqual(teacher);
    expect(findSessionTeacher("live", T0 + 1000)).toBeNull();
    expect(findSessionTeacher("unknown", T0)).toBeNull();
  });

  it("deletes one session or every expired one", () => {
    const teacher = insertTeacher({ email: "a@school.org", displayName: "A", passwordHash: "h" });
    insertSession({ tokenHash: "old-1", teacherId: teacher.id, expiresAt: T0 - 1 });
    insertSession({ tokenHash: "old-2", teacherId: teacher.id, expiresAt: T0 });
    insertSession({ tokenHash: "live", teacherId: teacher.id, expiresAt: T0 + 1 });
    insertSession({ tokenHash: "logout", teacherId: teacher.id, expiresAt: T0 + 1 });

    deleteSession("logout");
    expect(findSessionTeacher("logout", T0)).toBeNull();
    expect(deleteExpiredSessions(T0)).toBe(2);
    expect(findSessionTeacher("live", T0)).toEqual(teacher);
  });
});
