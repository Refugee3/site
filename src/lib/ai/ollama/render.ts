import "server-only";
import { createRequire } from "node:module";
import path from "node:path";
import { AiError } from "../errors";

// PDF → PNG page images for a local vision model, which can't read PDFs. pdf.js (legacy build, for Node) parses and draws
// the pages; @napi-rs/canvas, which ships prebuilt binaries for Windows, macOS and Linux, is the canvas it draws on. Both
// stay outside the server bundle (next.config.ts serverExternalPackages). Uploads are already PDFs when they get here: the
// upload pipeline turns photos, Word and text files into PDFs.

export interface RenderedPage {
  /** PNG bytes. */
  png: Uint8Array;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Pixels of the page's longer side. */
  maxEdge: number;
  /** A PDF with more pages is refused (the upload limits already keep PDFs within it). */
  maxPages: number;
  signal?: AbortSignal;
}

export type PdfRenderer = (pdf: Uint8Array, o: RenderOptions) => Promise<RenderedPage[]>;

export const RENDER_FAILED = "This PDF couldn't be turned into page images for the model on this computer.";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsModule: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsModule;
}

/** pdf.js's data files (fonts a PDF names without embedding them, character maps, image decoders), as directory paths. */
export function pdfJsAssets(): { standardFontDataUrl: string; cMapUrl: string; wasmUrl: string } {
  const requireFromApp = createRequire(path.join(/*turbopackIgnore: true*/ process.cwd(), "package.json"));
  const root = path.dirname(requireFromApp.resolve("pdfjs-dist/package.json"));
  // pdf.js insists on a trailing "/" and appends file names; Windows reads "C:\app\…\standard_fonts/x.pfb" fine.
  const dir = (name: string) => `${path.join(root, name)}/`;
  return { standardFontDataUrl: dir("standard_fonts"), cMapUrl: dir("cmaps"), wasmUrl: dir("wasm") };
}

/** Renders every page, in order, to a white-backed PNG whose longer side is `maxEdge` pixels. Rejects with AiError. */
export const renderPdfPages: PdfRenderer = async (pdf, o) => {
  const pdfjs = await loadPdfJs();
  // pdf.js may take over the buffer it is given; the caller's bytes stay intact.
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), ...pdfJsAssets(), verbosity: 0 });
  try {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await task.promise;
    } catch {
      throw new AiError("bad_request", RENDER_FAILED, { retryable: false });
    }
    if (doc.numPages > o.maxPages) {
      throw new AiError("request_too_large", `This PDF has ${doc.numPages} pages; at most ${o.maxPages} can be read.`, { retryable: false });
    }
    const pages: RenderedPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (o.signal?.aborted) throw new AiError("aborted", "Stopped while turning the PDF into images.", { retryable: true });
      const page = await doc.getPage(n);
      try {
        const unscaled = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: o.maxEdge / Math.max(unscaled.width, unscaled.height) });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: NapiCanvas } };
        const { canvas } = factory.create(width, height);
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "white" }).promise;
        pages.push({ png: new Uint8Array(await canvas.encode("png")), width, height });
      } catch (e) {
        if (e instanceof AiError) throw e;
        throw new AiError("bad_request", `${RENDER_FAILED} (page ${n})`, { retryable: false });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
};

/** The part of @napi-rs/canvas's Canvas used here (pdf.js creates it through its Node canvas factory). */
interface NapiCanvas {
  encode(format: "png"): Promise<Uint8Array>;
}
