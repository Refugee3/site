/** Returns a copy of `items` with the item at `index` swapped with its neighbour; out-of-range moves are no-ops. */
export function moveItem<T>(items: readonly T[], index: number, offset: -1 | 1): T[] {
  const next = [...items];
  const target = index + offset;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** PDFs are sent as they are; everything else is treated as a photo and re-encoded in the browser. */
export function isPdfFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

const MIB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}
