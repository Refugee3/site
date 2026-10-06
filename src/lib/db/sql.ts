import Database, { type Statement } from "better-sqlite3";
import { now } from "@/lib/clock";
import { getDb, type DB } from "@/lib/db/connection";

/** Values better-sqlite3 can bind. Booleans are not among them: encode them with `toBit`. */
export type SqlValue = string | number | bigint | Buffer | null;

const statements = new WeakMap<DB, Map<string, Statement<unknown[]>>>();

/** Prepares `source` on the current connection, once per connection. */
function prepare(source: string): Statement<unknown[]> {
  const db = getDb();
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(source);
  if (!statement) {
    statement = db.prepare(source);
    cache.set(source, statement);
  }
  return statement;
}

export function one<Row>(source: string, ...params: unknown[]): Row | undefined {
  return prepare(source).get(...params) as Row | undefined;
}

export function all<Row>(source: string, ...params: unknown[]): Row[] {
  return prepare(source).all(...params) as Row[];
}

/** Runs a write and returns the number of changed rows. */
export function run(source: string, ...params: unknown[]): number {
  return prepare(source).run(...params).changes;
}

export function toBit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Maps each field of T to its column, optionally with an encoder for values SQLite cannot store directly. */
export type ColumnMap<T> = {
  readonly [K in keyof T]-?: string | readonly [column: string, encode: (value: T[K]) => SqlValue];
};

/** Turns the defined fields of a patch into column values; fields missing from `columns` are ignored. */
export function encodePatch<T extends object>(patch: Partial<T>, columns: ColumnMap<T>): Record<string, SqlValue> {
  const values: Record<string, SqlValue> = {};
  for (const field of Object.keys(columns) as Array<keyof T>) {
    const value = patch[field];
    if (value === undefined) continue;
    const spec = columns[field];
    if (typeof spec === "string") values[spec] = value as SqlValue;
    else values[spec[0]] = spec[1](value as T[keyof T]);
  }
  return values;
}

/**
 * `UPDATE table SET <values>, updated_at = now WHERE <where> RETURNING *`.
 * Table and column names must come from code, never from input.
 */
export function updateRow<Row>(table: string, where: Record<string, SqlValue>, values: Record<string, SqlValue>): Row | undefined {
  const params: Record<string, SqlValue> = { set_updated_at: now() };
  const assignments = ["updated_at = @set_updated_at"];
  for (const [column, value] of Object.entries(values)) {
    assignments.push(`${column} = @set_${column}`);
    params[`set_${column}`] = value;
  }
  const conditions = Object.entries(where).map(([column, value]) => {
    params[`where_${column}`] = value;
    return `${column} = @where_${column}`;
  });
  return one<Row>(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING *`, params);
}

/** True for a UNIQUE violation on `constraint`, as SQLite names it (e.g. "teachers.email"). */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return error instanceof Database.SqliteError
    && error.code === "SQLITE_CONSTRAINT_UNIQUE"
    && error.message.includes(constraint);
}
