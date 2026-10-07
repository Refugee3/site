import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import type { DB } from "@/lib/db/connection";
import { clearStoredApiKey, getAppSettings, setStoredApiKey, setStudentsCanUpload } from "@/lib/db/repos/settings";
import { seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
const STORED = { ciphertext: "v1.iv.tag.ct", masked: "sk-ant-…a1b2", check: "verified" as const };

let db: DB;

beforeEach(() => {
  setClockForTests(() => T0);
  db = useTestDb();
});

describe("app settings", () => {
  it("start with student uploads off and no saved key", () => {
    expect(getAppSettings()).toEqual({
      studentsCanUpload: false, apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null, apiKeySetBy: null,
      apiKeySetAt: null, updatedAt: 0,
    });
  });

  it("turn student uploads on and off", () => {
    setStudentsCanUpload(true);
    expect(getAppSettings()).toMatchObject({ studentsCanUpload: true, updatedAt: T0 });
    setStudentsCanUpload(false);
    expect(getAppSettings().studentsCanUpload).toBe(false);
  });

  it("store, replace and clear the API key, leaving the upload switch alone", () => {
    const teacher = seedTeacher();
    const other = seedTeacher();
    setStudentsCanUpload(true);

    setStoredApiKey({ ...STORED, setBy: teacher.id });
    expect(getAppSettings()).toEqual({
      studentsCanUpload: true, apiKeyCiphertext: STORED.ciphertext, apiKeyMasked: STORED.masked, apiKeyCheck: "verified",
      apiKeySetBy: teacher.id, apiKeySetAt: T0, updatedAt: T0,
    });

    setClockForTests(() => T0 + 5);
    setStoredApiKey({ ciphertext: "v1.x.y.z", masked: "sk-ant-…zzzz", check: "unverified", setBy: other.id });
    expect(getAppSettings()).toMatchObject({
      apiKeyCiphertext: "v1.x.y.z", apiKeyMasked: "sk-ant-…zzzz", apiKeyCheck: "unverified", apiKeySetBy: other.id, apiKeySetAt: T0 + 5,
    });

    setClockForTests(() => T0 + 9);
    clearStoredApiKey();
    expect(getAppSettings()).toEqual({
      studentsCanUpload: true, apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null, apiKeySetBy: null,
      apiKeySetAt: null, updatedAt: T0 + 9,
    });
  });

  it("keep the saved key when the teacher who saved it is deleted", () => {
    const teacher = seedTeacher();
    setStoredApiKey({ ...STORED, setBy: teacher.id });

    db.prepare("DELETE FROM teachers WHERE id = ?").run(teacher.id);

    expect(getAppSettings()).toMatchObject({ apiKeyCiphertext: STORED.ciphertext, apiKeySetBy: null });
  });

  it("refuse a key saved by an unknown teacher", () => {
    expect(() => setStoredApiKey({ ...STORED, setBy: "missing" })).toThrow(/FOREIGN KEY/);
    expect(getAppSettings().apiKeyCiphertext).toBeNull();
  });
});
