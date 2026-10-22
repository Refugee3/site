import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * A thin layer over Node's built-in `node:sqlite` (no native addon to compile) with the subset of better-sqlite3's API
 * this app uses, and its semantics:
 * - parameters bind like better-sqlite3: values positionally (arrays are spread), and one plain object for the named
 *   ones, keyed without their `@`/`:`/`$` prefix. A missing named parameter, or too few or too many positional values,
 *   throws; extra keys in the object are ignored;
 * - rows are plain objects (node:sqlite returns null-prototype ones), `get` returns undefined when there is no row,
 *   integers are JS numbers (BLOBs come back as Uint8Array rather than Buffer; the schema has none);
 * - `transaction(fn)` runs `fn` in BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE] … COMMIT, rolling back when it throws; called
 *   inside a transaction it uses a savepoint instead, so transactions nest;
 * - `pragma(source, { simple })` returns the rows, or the first column of the first row.
 * Like better-sqlite3's build, foreign keys are enforced and double-quoted strings are identifiers (node:sqlite's
 * defaults). Importing node:sqlite makes Node print one "SQLite is an experimental feature" warning per process.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export type Transaction<A extends unknown[], R> = ((...args: A) => R) & {
  deferred: (...args: A) => R;
  immediate: (...args: A) => R;
  exclusive: (...args: A) => R;
};

interface Parameters {
  /** Number of `?` placeholders; null when the SQL uses numbered `?NNN` ones, which are bound unchecked. */
  positional: number | null;
  /** Distinct named parameters, without their prefix. */
  named: string[];
}

const IDENTIFIER_CHAR = /[\w$\u0080-￿]/;

/** Finds the bind parameters in `source`, skipping string literals, quoted identifiers and comments. */
function scanParameters(source: string): Parameters {
  let positional: number | null = 0;
  const named = new Set<string>();
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === "\"" || c === "`") {
      i = source.indexOf(c, i + 1); // a doubled quote is an escape: the scan resumes right after it
      if (i < 0) break;
    } else if (c === "[") {
      i = source.indexOf("]", i + 1);
      if (i < 0) break;
    } else if (c === "-" && source[i + 1] === "-") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      if (i <= 0) break;
    } else if (c === "?") {
      if (/\d/.test(source[i + 1] ?? "")) positional = null;
      else if (positional !== null) positional++;
    } else if ((c === "@" || c === ":" || c === "$") && IDENTIFIER_CHAR.test(source[i + 1] ?? "")
      && !IDENTIFIER_CHAR.test(source[i - 1] ?? " ")) { // `$` is also an identifier character (a$b)
      let end = i + 1;
      while (end < source.length && IDENTIFIER_CHAR.test(source[end])) end++;
      named.add(source.slice(i + 1, end));
      i = end - 1;
    }
  }
  return { positional, named: [...named] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function plainRow(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return row === undefined ? undefined : { ...row };
}

export class Statement {
  readonly source: string;
  readonly #statement: StatementSync;
  readonly #parameters: Parameters;

  constructor(statement: StatementSync, source: string) {
    this.source = source;
    this.#statement = statement;
    this.#parameters = scanParameters(source);
  }

  run(...params: unknown[]): RunResult {
    const { changes, lastInsertRowid } = this.#statement.run(...this.#bind(params));
    return { changes: Number(changes), lastInsertRowid };
  }

  get(...params: unknown[]): unknown {
    return plainRow(this.#statement.get(...this.#bind(params)));
  }

  all(...params: unknown[]): unknown[] {
    return this.#statement.all(...this.#bind(params)).map((row) => ({ ...row }));
  }

  /** better-sqlite3's binding rules, as node:sqlite arguments: the named values first (in an object), then the positional ones. */
  #bind(params: unknown[]): [Record<string, SQLInputValue>, ...SQLInputValue[]] {
    const positional: unknown[] = [];
    let object: Record<string, unknown> | undefined;
    for (const param of params) {
      if (Array.isArray(param)) positional.push(...param);
      else if (isPlainObject(param)) {
        if (object) throw new TypeError("You cannot specify named parameters in two different objects");
        object = param;
      } else positional.push(param);
    }
    const { positional: expected, named } = this.#parameters;
    if (expected !== null && positional.length !== expected) {
      throw new RangeError(positional.length < expected ? "Too few parameter values were provided" : "Too many parameter values were provided");
    }
    const values: Record<string, SQLInputValue> = {};
    for (const name of named) {
      if (!object || !Object.hasOwn(object, name)) throw new RangeError(`Missing named parameter "${name}"`);
      values[name] = bindable(object[name]);
    }
    return [values, ...positional.map(bindable)];
  }
}

/** Checked here rather than left to node:sqlite, whose handling differs by version (Node 24 binds booleans as 1/0). */
function bindable(value: unknown): SQLInputValue {
  if (typeof value === "boolean") throw new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
  if (value === undefined) throw new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
  return value as SQLInputValue;
}

export class Database {
  /** The file name the database was opened with (":memory:" for an in-memory one). */
  readonly name: string;
  readonly #db: DatabaseSync;
  #open = true;
  /** Transactions entered through `transaction()`; tells whether one is open on Node versions without `isTransaction`. */
  #depth = 0;
  #control: Record<"begin" | "beginImmediate" | "beginExclusive" | "commit" | "rollback" | "savepoint" | "release" | "rollbackTo", StatementSync> | undefined;

  constructor(filename: string) {
    this.name = filename;
    this.#db = new DatabaseSync(filename);
  }

  get open(): boolean {
    return this.#open;
  }

  get inTransaction(): boolean {
    const native = (this.#db as { isTransaction?: unknown }).isTransaction; // Node >= 22.16
    return typeof native === "boolean" ? native : this.#depth > 0;
  }

  prepare(source: string): Statement {
    return new Statement(this.#db.prepare(source), source);
  }

  exec(source: string): this {
    this.#db.exec(source);
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const statement = this.#db.prepare(`PRAGMA ${source}`);
    if (!options.simple) return statement.all().map((row) => ({ ...row }));
    const row = statement.get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R> {
    const wrap = (begin: "begin" | "beginImmediate" | "beginExclusive") => (...args: A): R => this.#runTransaction(begin, fn, args);
    return Object.assign(wrap("begin"), { deferred: wrap("begin"), immediate: wrap("beginImmediate"), exclusive: wrap("beginExclusive") });
  }

  close(): this {
    if (this.#open) {
      this.#db.close();
      this.#open = false;
      this.#control = undefined;
    }
    return this;
  }

  #runTransaction<A extends unknown[], R>(begin: "begin" | "beginImmediate" | "beginExclusive", fn: (...args: A) => R, args: A): R {
    const control = this.#controlStatements();
    const nested = this.inTransaction;
    (nested ? control.savepoint : control[begin]).run();
    this.#depth++;
    try {
      const result = fn(...args);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("Transaction function cannot return a promise");
      }
      (nested ? control.release : control.commit).run();
      return result;
    } catch (error) {
      // SQLite may already have rolled the transaction back (e.g. a full disk); then there is nothing to undo.
      if (this.inTransaction) {
        try {
          if (nested) {
            control.rollbackTo.run();
            control.release.run();
          } else {
            control.rollback.run();
          }
        } catch (undoError) {
          // Without isTransaction the depth count cannot tell an automatic rollback; keep the original error then.
          if (typeof (this.#db as { isTransaction?: unknown }).isTransaction === "boolean") throw undoError;
        }
      }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  #controlStatements() {
    this.#control ??= {
      begin: this.#db.prepare("BEGIN"),
      beginImmediate: this.#db.prepare("BEGIN IMMEDIATE"),
      beginExclusive: this.#db.prepare("BEGIN EXCLUSIVE"),
      commit: this.#db.prepare("COMMIT"),
      rollback: this.#db.prepare("ROLLBACK"),
      savepoint: this.#db.prepare("SAVEPOINT \"pag.tx\""),
      release: this.#db.prepare("RELEASE \"pag.tx\""),
      rollbackTo: this.#db.prepare("ROLLBACK TO \"pag.tx\""),
    };
    return this.#control;
  }
}

/** SQLite's extended result code for a UNIQUE violation. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** True for SQLite's UNIQUE-constraint error, as node:sqlite throws it (`errcode` is the extended result code). */
export function isSqliteUniqueError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  if (code !== "ERR_SQLITE_ERROR") return false;
  return typeof errcode === "number" ? errcode === SQLITE_CONSTRAINT_UNIQUE : error.message.startsWith("UNIQUE constraint failed:");
}
