import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDb, openDatabase, setDbForTests, tx } from "@/lib/db/connection";
import { MIGRATIONS } from "@/lib/db/migrations";

const DB_SLOT = Symbol.for("pag.db");

describe("getDb", () => {
  it("opens ${DATA_DIR}/app.db, creating the directory, with the connection pragmas and migrations", () => {
    const dataDir = path.join(process.env.DATA_DIR!, "nested", "data");
    vi.stubEnv("DATA_DIR", dataDir);

    const db = getDb();

    expect(db.name).toBe(path.join(dataDir, "app.db"));
    expect(fs.existsSync(path.join(dataDir, "app.db"))).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("is a process-wide singleton stored in the pag.db slot", () => {
    const db = getDb();
    expect(getDb()).toBe(db);
    expect((globalThis as unknown as Record<symbol, unknown>)[DB_SLOT]).toBe(db);
  });

  it("reopens after the slot is cleared, and setDbForTests closes the previous connection", () => {
    const first = getDb();
    setDbForTests(null);
    expect(first.open).toBe(false);
    const second = getDb();
    expect(second).not.toBe(first);

    const memory = openDatabase(":memory:");
    setDbForTests(memory);
    expect(second.open).toBe(false);
    expect(getDb()).toBe(memory);
  });
});

describe("tx", () => {
  function setup() {
    const db = openDatabase(":memory:");
    setDbForTests(db);
    const names = () => (db.prepare("SELECT display_name FROM teachers ORDER BY display_name").all() as Array<{ display_name: string }>)
      .map((r) => r.display_name);
    const insert = (name: string) => db.prepare(
      "INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, 'h', 1)",
    ).run(name, `${name}@example.com`, name);
    return { names, insert };
  }

  it("commits and returns the function's value", () => {
    const { names, insert } = setup();
    expect(tx(() => {
      insert("a");
      return 42;
    })).toBe(42);
    expect(names()).toEqual(["a"]);
  });

  it("rolls back everything when the function throws", () => {
    const { names, insert } = setup();
    expect(() => tx(() => {
      insert("a");
      throw new Error("boom");
    })).toThrow("boom");
    expect(names()).toEqual([]);
  });

  it("turns nested calls into savepoints", () => {
    const { names, insert } = setup();
    tx(() => {
      insert("outer");
      expect(() => tx(() => {
        insert("inner");
        throw new Error("inner failed");
      })).toThrow("inner failed");
      tx(() => insert("inner-ok"));
    });
    expect(names()).toEqual(["inner-ok", "outer"]);
  });
});
