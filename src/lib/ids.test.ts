import { describe, expect, it } from "vitest";
import { isId, isToken, newId, newShareCode, newToken, normalizeShareCode, sha256Hex } from "@/lib/ids";

describe("ids", () => {
  it("newId produces UUIDs that isId accepts", () => {
    expect(isId(newId())).toBe(true);
    expect(isId("3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b")).toBe(true);
  });

  it.each(["", "not-a-uuid", "3f2b8c1e9a4d4e7f8b6a1c2d3e4f5a6b", "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6", "../../etc/passwd",
    "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b "])("isId rejects %j", (s) => {
    expect(isId(s)).toBe(false);
  });

  it("newToken produces 43-character base64url tokens that isToken accepts", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isToken(token)).toBe(true);
    expect(newToken()).not.toBe(token);
  });

  it.each(["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, `${"a".repeat(42)}/`])(
    "isToken rejects %j",
    (s) => {
      expect(isToken(s)).toBe(false);
    },
  );

  it("newShareCode uses only the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = newShareCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(normalizeShareCode(code)).toBe(code);
    }
  });

  it.each([
    ["K7M4QX", "K7M4QX"],
    ["k7m4qx", "K7M4QX"],
    ["K7M-4QX", "K7M4QX"],
    [" k7m 4qx ", "K7M4QX"],
    ["k-7-m-4-q-x", "K7M4QX"],
  ])("normalizeShareCode(%j) → %j", (input, expected) => {
    expect(normalizeShareCode(input)).toBe(expected);
  });

  it.each(["", "K7M4Q", "K7M4QXA", "K7M4Q0", "K7M4QI", "K7M4QL", "K7M4Q1", "K7M_4QX", "K7M4QX!", "КЕМ4QX"])(
    "normalizeShareCode(%j) → null",
    (input) => {
      expect(normalizeShareCode(input)).toBeNull();
    },
  );

  it("sha256Hex hashes strings and bytes identically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});
