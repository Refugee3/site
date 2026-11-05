import { afterEach, describe, expect, it } from "vitest";
import { Database, isSqliteUniqueError } from "@/lib/db/sqlite";

let db: Database;

function open(): Database {
  db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT UNIQUE, \"x$y\" TEXT)");
  return db;
}

afterEach(() => db?.close());

describe("Statement", () => {
  it("binds named parameters from one object keyed without prefix, ignoring extra keys", () => {
    open();
    const result = db.prepare("INSERT INTO t (a, b) VALUES (@a, $b)").run({ a: "one", b: "two", unused: 1 });
    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.prepare("SELECT a, b FROM t WHERE a = :a AND id = ?").get({ a: "one" }, 1)).toEqual({ a: "one", b: "two" });
  });

  it("throws on a missing named parameter instead of binding NULL", () => {
    open();
    expect(() => db.prepare("INSERT INTO t (a, b) VALUES (@a, @b)").run({ a: "one" })).toThrow('Missing named parameter "b"');
    expect(() => db.prepare("INSERT INTO t (a) VALUES (@a)").run()).toThrow('Missing named parameter "a"');
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
  });

  it("checks the number of positional values; arrays are spread", () => {
    open();
    expect(() => db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("one")).toThrow("Too few parameter values");
    expect(() => db.prepare("INSERT INTO t (a) VALUES (?)").run("one", "two")).toThrow("Too many parameter values");
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(["one", "two"]);
    expect(db.prepare("SELECT a, b FROM t").all()).toEqual([{ a: "one", b: "two" }]);
  });

  it("ignores placeholder-like text in strings, quoted identifiers and comments", () => {
    open();
    db.prepare("INSERT INTO t (a, \"x$y\") VALUES ('?:@ $z', ?) -- @c ?\n").run("v");
    db.prepare("INSERT INTO t (a, [x$y]) /* :d ? */ VALUES ('it''s @e', @f)").run({ f: "w" });
    expect(db.prepare("SELECT a, \"x$y\" AS xy FROM t ORDER BY id").all()).toEqual([{ a: "?:@ $z", xy: "v" }, { a: "it's @e", xy: "w" }]);
  });

  it("returns plain-object rows, undefined for no row, and integers as numbers", () => {
    open();
    db.prepare("INSERT INTO t (id, a) VALUES (?, ?)").run(7, "x");
    const row = db.prepare("SELECT id, a FROM t").get() as { id: number };
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(typeof row.id).toBe("number");
    expect(Object.getPrototypeOf(db.prepare("SELECT id FROM t").all()[0])).toBe(Object.prototype);
    expect(db.prepare("SELECT id FROM t WHERE id = ?").get(8)).toBeUndefined();
    expect(db.prepare("UPDATE t SET a = 'y' WHERE id = ? RETURNING a").get(7)).toEqual({ a: "y" });
  });

  it("refuses booleans and undefined", () => {
    open();
    expect(() => db.prepare("SELECT ?").get(true)).toThrow();
    expect(() => db.prepare("SELECT @v").get({ v: undefined })).toThrow();
  });
});

describe("Database", () => {
  it("reads pragmas as rows or, with simple, as the first value", () => {
    open();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    db.pragma("user_version = 3");
    expect(db.pragma("user_version")).toEqual([{ user_version: 3 }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("reports its name and open state, and closes once", () => {
    open();
    expect(db.name).toBe(":memory:");
    expect(db.open).toBe(true);
    db.close().close();
    expect(db.open).toBe(false);
  });

  it("recognises UNIQUE violations", () => {
    open();
    const insert = db.prepare("INSERT INTO t (b) VALUES (?)");
    insert.run("same");
    let error: unknown;
    try {
      insert.run("same");
    } catch (e) {
      error = e;
    }
    expect(isSqliteUniqueError(error)).toBe(true);
    expect((error as Error).message).toContain("t.b");
    expect(isSqliteUniqueError(new Error("UNIQUE constraint failed: t.b"))).toBe(false);
  });
});

describe("transaction", () => {
  const names = () => (db.prepare("SELECT a FROM t ORDER BY a").all() as Array<{ a: string }>).map((r) => r.a);
  const insert = (a: string) => db.prepare("INSERT INTO t (a) VALUES (?)").run(a);

  it("commits, passes arguments and returns the value", () => {
    open();
    const add = db.transaction((a: string, b: string) => {
      insert(a);
      insert(b);
      return db.inTransaction;
    });
    expect(add.immediate("x", "y")).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(names()).toEqual(["x", "y"]);
  });

  it("rolls back when the function throws, and nests with savepoints", () => {
    open();
    expect(() => db.transaction(() => {
      insert("outer");
      throw new Error("boom");
    }).immediate()).toThrow("boom");
    expect(names()).toEqual([]);

    db.transaction(() => {
      insert("outer");
      expect(() => db.transaction(() => {
        insert("inner");
        throw new Error("inner failed");
      })()).toThrow("inner failed");
      expect(db.inTransaction).toBe(true);
      db.transaction(() => insert("inner-ok")).immediate();
    }).immediate();
    expect(names()).toEqual(["inner-ok", "outer"]);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses an async function and rolls back", () => {
    open();
    expect(() => db.transaction(async () => {
      insert("x");
    })()).toThrow("cannot return a promise");
    expect(names()).toEqual([]);
  });
});
