// Renders PDF pages in a worker thread (src/lib/omr/render-pool.ts starts it). Plain JavaScript, never bundled: it is
// loaded by path at run time and imports pdf.js and @napi-rs/canvas from node_modules.
//
// Messages in:  { op: "gray", doc, bytes?, page, dpi? | widthPx? }   { op: "png", doc, bytes?, page, maxEdge }
//               { op: "close", doc }
// Messages out: { ready: true } once loaded, then one reply per render (the pool sends one at a time):
//               { ok: true, width, height, data } (data's buffer is transferred) or { ok: false, message, unreadable }.

import { parentPort, workerData } from "node:worker_threads";

const loaded = Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas")]).then(([pdfjs]) => pdfjs);

/** Open documents by the main thread's id; the bytes come with the first request for each. */
const docs = new Map();

function open(id, bytes) {
  let entry = docs.get(id);
  if (!entry) {
    if (!bytes) throw Object.assign(new Error("document not sent"), { unreadable: false });
    entry = loaded.then(async (pdfjs) => {
      const task = pdfjs.getDocument({ data: bytes, ...workerData.assets, verbosity: 0 });
      try {
        return { task, doc: await task.promise };
      } catch {
        await task.destroy().catch(() => undefined);
        throw Object.assign(new Error("unreadable PDF"), { unreadable: true });
      }
    });
    docs.set(id, entry);
    entry.catch(() => docs.delete(id));
  }
  return entry;
}

async function close(id) {
  const entry = docs.get(id);
  docs.delete(id);
  const opened = await entry?.catch(() => null);
  await opened?.task.destroy().catch(() => undefined);
}

/** Same arithmetic as grayFromRgba in src/lib/omr/image.ts (a test checks the pixels match). */
function grayFromRgba(rgba, width, height) {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const alpha = rgba[j + 3];
    const luma = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    data[i] = Math.round(255 - ((255 - luma) * alpha) / 255);
  }
  return data;
}

async function render(msg) {
  const { doc } = await open(msg.doc, msg.bytes);
  const page = await doc.getPage(msg.page);
  try {
    const unscaled = page.getViewport({ scale: 1 });
    const scale = msg.op === "png"
      ? msg.maxEdge / Math.max(unscaled.width, unscaled.height)
      : msg.dpi !== undefined ? msg.dpi / 72 : msg.widthPx / unscaled.width;
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const { canvas, context } = doc.canvasFactory.create(width, height);
    await page.render({ canvas, viewport, background: "white" }).promise;
    // A fresh buffer either way, so it can be transferred.
    const data = msg.op === "png"
      ? new Uint8Array(await canvas.encode("png"))
      : grayFromRgba(context.getImageData(0, 0, width, height).data, width, height);
    return { width, height, data };
  } finally {
    page.cleanup();
  }
}

async function handle(msg) {
  if (msg.op === "close") return close(msg.doc);
  try {
    const r = await render(msg);
    parentPort.postMessage({ ok: true, ...r }, [r.data.buffer]);
  } catch (e) {
    parentPort.postMessage({ ok: false, message: String(e?.message ?? e), unreadable: e?.unreadable === true });
  }
}

// One message at a time, in order: a document is closed only after the render sent before its close.
let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  chain = chain.then(() => handle(msg));
});

// A failed load is left unhandled, which ends the worker: the pool then renders in-process.
void loaded.then(() => parentPort.postMessage({ ready: true }));
