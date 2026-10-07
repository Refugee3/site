import path from "node:path";
import { getConfig } from "@/lib/config";

// Stored paths are built only from server-generated UUIDs; anything else is refused before it reaches the filesystem.
const DATA_FILE_PATH = /^files\/[0-9a-f-]{36}\/(key|submissions|scans)\/[0-9a-f-]{36}\.pdf$/;

export function dataDir(): string {
  return getConfig().dataDir;
}

/** The absolute path of a stored PDF; throws unless `rel` has the expected shape and stays inside the data directory. */
export function resolveDataPath(rel: string): string {
  if (!DATA_FILE_PATH.test(rel)) throw new Error("Refusing a data file path with an unexpected shape");
  const root = dataDir();
  const absolute = path.resolve(root, rel);
  if (!absolute.startsWith(root + path.sep)) throw new Error("Refusing a data file path outside the data directory");
  return absolute;
}

export function submissionPdfRel(assignmentId: string, submissionId: string): string {
  return `files/${assignmentId}/submissions/${submissionId}.pdf`;
}

export function keyPdfRel(assignmentId: string, fileId: string): string {
  return `files/${assignmentId}/key/${fileId}.pdf`;
}

export function scanPdfRel(assignmentId: string, scanId: string): string {
  return `files/${assignmentId}/scans/${scanId}.pdf`;
}
