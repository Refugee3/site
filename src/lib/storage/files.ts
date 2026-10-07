import fs from "node:fs/promises";
import path from "node:path";
import { now } from "@/lib/clock";
import { AppError } from "@/lib/errors";
import { isId, newId } from "@/lib/ids";
import { dataDir, resolveDataPath } from "@/lib/storage/paths";

const FILE_MODE = 0o640;

function filesDir(): string {
  return path.join(dataDir(), "files");
}

function tmpDir(): string {
  return path.join(dataDir(), "tmp");
}

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(filesDir(), { recursive: true });
  await fs.mkdir(tmpDir(), { recursive: true });
}

/** Deletes staging files older than `olderThanMs` (left by writes that crashed mid-way); returns how many. */
export async function sweepTmp(olderThanMs: number): Promise<number> {
  const dir = tmpDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return 0;
    throw e;
  }
  const cutoff = now() - olderThanMs;
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file).catch(() => null); // may vanish while we sweep
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(file, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Writes via a synced staging file in tmp/ and a rename, so readers never see a partial PDF. */
export async function writeFileAtomic(rel: string, bytes: Uint8Array): Promise<void> {
  const target = resolveDataPath(rel);
  const staging = path.join(tmpDir(), newId());
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(tmpDir(), { recursive: true });
  try {
    await writeAndSync(staging, bytes);
    await fs.rename(staging, target);
  } catch (e) {
    await fs.rm(staging, { force: true });
    throw e;
  }
}

async function writeAndSync(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(file, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readDataFile(rel: string): Promise<Uint8Array> {
  const file = resolveDataPath(rel);
  try {
    const buffer = await fs.readFile(file);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (e) {
    if (isNotFound(e)) throw new AppError("file_missing", "The file is missing on the server.");
    throw e;
  }
}

/**
 * Best effort: removals happen after the database commit, so a failure is logged, never thrown.
 * A malformed path still throws, because that is a bug rather than an I/O problem.
 */
export async function removeDataFile(rel: string): Promise<void> {
  const file = resolveDataPath(rel);
  await fs.rm(file, { force: true }).catch((e: unknown) => logRemovalFailure(rel, e));
}

/** Best effort, like `removeDataFile`: deletes the assignment's key and submission PDFs. */
export async function removeAssignmentFiles(assignmentId: string): Promise<void> {
  if (!isId(assignmentId)) throw new Error("Refusing to remove files for a malformed assignment id");
  const dir = path.join(filesDir(), assignmentId);
  await fs.rm(dir, { recursive: true, force: true }).catch((e: unknown) => logRemovalFailure(`files/${assignmentId}`, e));
}

function logRemovalFailure(rel: string, e: unknown): void {
  const code = (e as NodeJS.ErrnoException | null)?.code ?? "unknown";
  console.error(`Could not remove ${rel} (${code})`);
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** A stored PDF as an inline download that is never cached, sniffed, or named after a user's file. */
export function pdfResponse(bytes: Uint8Array): Response {
  return new Response(asArrayBufferView(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="submission.pdf"',
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// BodyInit only accepts views over a plain ArrayBuffer; copy in the (never expected) shared-memory case.
function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}
