import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "@/lib/config";
import { migrate } from "@/lib/db/migrations";

export type DB = import("better-sqlite3").Database;

// Process-wide globalThis slot so separate module copies share it: instrumentation and route bundles
// may load separate copies of this module.
const DB_SLOT = Symbol.for("pag.db");
const slots = globalThis as unknown as Record<symbol, DB | undefined>;

/** Opens a database (":memory:" works), applies the connection pragmas and runs pending migrations. */
export function openDatabase(file: string): DB {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The shared connection to `${dataDir}/app.db`, opened (and migrated) on first use. */
export function getDb(): DB {
  let db = slots[DB_SLOT];
  if (!db) {
    const { dataDir } = getConfig();
    fs.mkdirSync(dataDir, { recursive: true });
    db = openDatabase(path.join(dataDir, "app.db"));
    slots[DB_SLOT] = db;
  }
  return db;
}

/** Installs `db` as the shared connection (null removes it); the previous connection is closed. */
export function setDbForTests(db: DB | null): void {
  const previous = slots[DB_SLOT];
  if (previous && previous !== db && previous.open) previous.close();
  if (db) slots[DB_SLOT] = db;
  else delete slots[DB_SLOT];
}

/**
 * Runs `fn` in a BEGIN IMMEDIATE transaction. `fn` must be synchronous.
 * Nested calls become savepoints, so repo functions may use tx() inside a caller's tx().
 */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}
