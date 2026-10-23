const DEFAULT_MAX_EDGE = 2000;
const DEFAULT_QUALITY = 0.85;

/** Scales (width, height) down so the longer edge is at most `maxEdge`; never scales up. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "IMG_0042.HEIC" → "IMG_0042.jpg"; a nameless camera capture becomes "photo.jpg". */
export function jpegFileName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "").trim();
  return `${base || "photo"}.jpg`;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // Browsers that predate the "from-image" option reject the options dictionary itself; they already
    // apply EXIF orientation by default, so decode again without it. Undecodable data fails both ways.
    if (!(e instanceof TypeError)) throw e;
    return createImageBitmap(file);
  }
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the photo."))),
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Re-encodes a photo (JPEG, PNG, or HEIC where the browser can decode it) as a JPEG whose long edge is at
 * most `maxEdge`, with EXIF orientation applied, so uploads stay small and the server only sees PDF/JPEG.
 * Rejects when the browser cannot decode the file (e.g. HEIC on Chrome).
 */
export async function prepareImage(file: File, o: { maxEdge?: number; quality?: number } = {}): Promise<File> {
  const bitmap = await decode(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, o.maxEdge ?? DEFAULT_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process the photo.");
    // JPEG has no transparency; paint white first so transparent PNG areas do not turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await toJpegBlob(canvas, o.quality ?? DEFAULT_QUALITY);
    return new File([blob], jpegFileName(file.name), { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}
