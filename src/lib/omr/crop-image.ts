import "server-only";
import { CROP_DPI, cropMapped, mappedRect } from "./detect";
import { grayToPngWithOutlines, openPdf, type Outline } from "./pdf-raster";
import { applyAffine } from "./register";
import type { SpotBox, SpotEvidence } from "./types";

// The review page's picture of an answer spot: the paper's page rendered, the spot's area cut out (through the blank → paper
// map found when it was graded), and the options outlined: the one(s) read as marked in green, the others in grey.

const MARKED = "#15803d";
const OTHER = "#94a3b8";
const AREA = "#2563eb";

export async function renderSpotCrop(paperPdf: Uint8Array, spot: SpotEvidence): Promise<Uint8Array> {
  const doc = await openPdf(paperPdf);
  try {
    const page = Math.min(Math.max(1, spot.page), doc.numPages);
    const img = await doc.renderGray(page, { dpi: CROP_DPI });
    const rect = mappedRect(spot.map, spot.crop);
    const crop = cropMapped(img, spot.map, spot.crop);
    const x0 = Math.max(0, Math.floor(rect.x * img.width));
    const y0 = Math.max(0, Math.floor(rect.y * img.height));
    const toCrop = (box: SpotBox): Array<[number, number]> => [
      [box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ].map(([u, v]) => {
      const [pu, pv] = applyAffine(spot.map, u, v);
      return [pu * img.width - x0, pv * img.height - y0];
    });
    const marked = new Set(spot.marked ?? []);
    const outlines: Outline[] = [
      ...(spot.options ?? []).filter((o) => !marked.has(o.value)).map((o) => ({ points: toCrop(o.box), color: OTHER, width: 1 })),
      ...(spot.options ?? []).filter((o) => marked.has(o.value)).map((o) => ({ points: toCrop(o.box), color: MARKED, width: 3 })),
      ...(spot.boxes ?? []).map((b) => ({ points: toCrop(b), color: AREA, width: 1 })),
    ];
    return grayToPngWithOutlines(crop, outlines);
  } finally {
    await doc.close();
  }
}
