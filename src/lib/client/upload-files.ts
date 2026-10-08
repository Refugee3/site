import { prepareImage } from "./images";

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

/** What every upload picker offers: PDFs, any image (HEIC included), Word and plain-text files. */
export const UPLOAD_ACCEPT = "application/pdf,image/*,.heic,.heif,.docx,.txt,.md,.csv";
export const UPLOAD_FORMATS = "PDF, photos, Word or text files";
export const UNSUPPORTED_IMAGE = "This image format can't be opened in this browser. Export it as JPEG or PDF and try again.";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp|avif)$/i;

/** Photos and other images; these are converted to JPEG in the browser before uploading. */
export function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return (file.type.startsWith("image/") && file.type !== "image/svg+xml") || IMAGE_EXTENSIONS.test(file.name);
}

/**
 * The file as it is uploaded: images (whatever their format) re-encoded as JPEG, everything else (PDF, Word,
 * text) unchanged for the server to convert. Rejects when the browser can't decode an image.
 */
export async function prepareUploadFile(file: File): Promise<File> {
  return isImageFile(file) ? prepareImage(file) : file;
}

/** A short label for a file without a thumbnail ("PDF", "DOCX", "TXT"). */
export function fileTypeLabel(name: string): string {
  const extension = /\.([a-z0-9]{1,4})$/i.exec(name)?.[1];
  return extension ? extension.toUpperCase() : "FILE";
}

const MIB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}
