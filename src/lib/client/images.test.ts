import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitWithin, jpegFileName, prepareImage } from "./images";

describe("fitWithin", () => {
  it("scales the long edge down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it("never scales up and never returns a zero edge", () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, 2000)).toEqual({ width: 2000, height: 1 });
  });
});

describe("jpegFileName", () => {
  it("swaps the extension for .jpg", () => {
    expect(jpegFileName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(jpegFileName("page.1.png")).toBe("page.1.jpg");
    expect(jpegFileName("scan")).toBe("scan.jpg");
    expect(jpegFileName("")).toBe("photo.jpg");
  });
});

describe("prepareImage", () => {
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn<(callback: (blob: Blob | null) => void, type: string, quality: number) => void>((callback) =>
      callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    ),
  };
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  const createImageBitmap = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    createImageBitmap.mockResolvedValue(bitmap);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-encodes a photo as a downscaled JPEG on a white background", async () => {
    const photo = new File(["raw"], "IMG_0042.HEIC", { type: "image/heic" });
    const result = await prepareImage(photo);

    expect(createImageBitmap).toHaveBeenCalledWith(photo, { imageOrientation: "from-image" });
    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(1500);
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 2000, 1500);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2000, 1500);
    expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.85);
    expect(result.name).toBe("IMG_0042.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("honours maxEdge and quality", async () => {
    await prepareImage(new File(["raw"], "a.png"), { maxEdge: 1000, quality: 0.5 });
    expect(canvas.width).toBe(1000);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.5);
  });

  it("decodes again without options on browsers that reject the orientation option", async () => {
    createImageBitmap.mockRejectedValueOnce(new TypeError("bad option")).mockResolvedValueOnce(bitmap);
    const photo = new File(["raw"], "a.jpg");
    await prepareImage(photo);
    expect(createImageBitmap).toHaveBeenLastCalledWith(photo);
  });

  it("rejects files the browser cannot decode", async () => {
    createImageBitmap.mockRejectedValue(new DOMException("undecodable", "InvalidStateError"));
    await expect(prepareImage(new File(["raw"], "a.heic"))).rejects.toThrow("undecodable");
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("rejects and releases the bitmap when encoding fails", async () => {
    canvas.toBlob.mockImplementationOnce((callback) => callback(null));
    await expect(prepareImage(new File(["raw"], "a.jpg"))).rejects.toThrow("Could not encode");
    expect(bitmap.close).toHaveBeenCalled();
  });
});
