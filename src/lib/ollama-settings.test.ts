import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_SETTINGS, DEFAULT_OLLAMA_SPEED, imageEdgeHint, OllamaBaseUrlSchema, ollamaImageEdge, ollamaModelFamily, OllamaModelSchema,
  OllamaNumCtxSchema, OllamaSettingsSchema, OllamaSpeedSchema, PAPERS_AT_A_TIME_HINT, pullCommand, visionFromName,
} from "@/lib/ollama-settings";

describe("Ollama settings validation", () => {
  it("defaults to Ollama's usual address, qwen2.5vl:7b and a 16k context", () => {
    expect(DEFAULT_OLLAMA_SETTINGS).toEqual({ baseUrl: "http://localhost:11434", model: "qwen2.5vl:7b", numCtx: 16_384 });
    expect(OllamaSettingsSchema.parse(DEFAULT_OLLAMA_SETTINGS)).toEqual(DEFAULT_OLLAMA_SETTINGS);
  });

  it.each([
    [" http://localhost:11434/ ", "http://localhost:11434"],
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
    ["https://gpu-box.school.lan", "https://gpu-box.school.lan"],
    ["http://proxy.lan/ollama//", "http://proxy.lan/ollama"],
  ])("accepts the address %j as %j", (input, output) => {
    expect(OllamaBaseUrlSchema.parse(input)).toBe(output);
  });

  it.each(["", "localhost:11434", "ftp://localhost", "http://user:pw@localhost:11434", "http://localhost:11434/?x=1", "http://a/#b",
    `http://${"a".repeat(200)}.lan`])("refuses the address %j", (input) => {
    expect(OllamaBaseUrlSchema.safeParse(input).success).toBe(false);
  });

  it.each(["qwen2.5vl:7b", "gemma3:12b", "llava", "hf.co/ggml-org/gemma-3-4b-it-GGUF:Q4_K_M", "library/qwen2.5vl:32b"])(
    "accepts the model %j",
    (model) => {
      expect(OllamaModelSchema.parse(` ${model} `)).toBe(model);
    },
  );

  it.each(["", " ", "qwen 2.5", "rm -rf /", ":7b", "a".repeat(101), "model;ls"])("refuses the model %j", (model) => {
    expect(OllamaModelSchema.safeParse(model).success).toBe(false);
  });

  it("takes the context size as a whole number from 4096 to 131072 (a form field is text)", () => {
    expect(OllamaNumCtxSchema.parse("32768")).toBe(32_768);
    for (const bad of ["4095", "131073", "16384.5", "lots", ""]) expect(OllamaNumCtxSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("knows the vision families by name and the pull command", () => {
    expect(visionFromName("qwen2.5vl:7b")).toBe(true);
    expect(visionFromName("llama3.2-vision:11b")).toBe(true);
    expect(visionFromName("gemma3:12b")).toBe(true);
    expect(visionFromName("llama3.1:8b")).toBeNull();
    expect(pullCommand("qwen2.5vl:7b")).toBe("ollama pull qwen2.5vl:7b");
  });
});

describe("page image size by model family", () => {
  it.each([
    ["qwen2.5vl:32b", "qwen"], ["qwen2.5vl:7b", "qwen"], ["library/qwen3-vl:8b", "qwen"], ["gemma3:27b", "gemma"],
    ["hf.co/ggml-org/gemma-3-4b-it-GGUF:Q4_K_M", "gemma"], ["llava:13b", "other"], ["minicpm-v", "other"],
  ] as const)("knows %j as %s", (model, family) => {
    expect(ollamaModelFamily(model)).toBe(family);
  });

  it("is 1280 px for Qwen, 896 for Gemma (it resizes to 896 itself) and 1600 otherwise, unless set", () => {
    const auto = { setting: null, env: null };
    expect(ollamaImageEdge("qwen2.5vl:32b", auto)).toBe(1280);
    expect(ollamaImageEdge("gemma3:27b", auto)).toBe(896);
    expect(ollamaImageEdge("llava:13b", auto)).toBe(1600);
    // OLLAMA_IMAGE_MAX_EDGE, then Settings, come first…
    expect(ollamaImageEdge("qwen2.5vl:32b", { setting: null, env: 1600 })).toBe(1600);
    expect(ollamaImageEdge("qwen2.5vl:32b", { setting: 1024, env: 1600 })).toBe(1024);
    // …but Gemma is never sent more than 1024 px: it would only be rendering and transfer work.
    expect(ollamaImageEdge("gemma3:27b", { setting: 2048, env: null })).toBe(1024);
    expect(ollamaImageEdge("gemma3:27b", { setting: null, env: 1600 })).toBe(1024);
    expect(ollamaImageEdge("gemma3:27b", { setting: 768, env: null })).toBe(768);
  });

  it("explains the automatic size in Settings", () => {
    expect(imageEdgeHint("gemma3:27b", null)).toContain("Empty = automatic: 896 px for gemma3:27b.");
    expect(imageEdgeHint("qwen2.5vl:32b", 1400)).toContain("Empty = automatic: 1400 px for qwen2.5vl:32b (OLLAMA_IMAGE_MAX_EDGE on the server).");
  });
});

describe("speed settings validation", () => {
  it("takes an empty page image size and papers at a time as not set", () => {
    expect(OllamaSpeedSchema.parse({ imageMaxEdge: "", papersAtATime: "" })).toEqual(DEFAULT_OLLAMA_SPEED);
    expect(OllamaSpeedSchema.parse({})).toEqual(DEFAULT_OLLAMA_SPEED);
    expect(OllamaSpeedSchema.parse({ imageMaxEdge: " 1280 ", papersAtATime: "2" })).toEqual({ imageMaxEdge: 1280, papersAtATime: 2 });
  });

  it.each([
    [{ imageMaxEdge: "511" }, "imageMaxEdge"], [{ imageMaxEdge: "4097" }, "imageMaxEdge"], [{ imageMaxEdge: "1280.5" }, "imageMaxEdge"],
    [{ papersAtATime: "0" }, "papersAtATime"], [{ papersAtATime: "5" }, "papersAtATime"], [{ papersAtATime: "two" }, "papersAtATime"],
  ])("refuses %j", (input, field) => {
    const result = OllamaSpeedSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual([field]);
  });

  it("says how to use more than one paper at a time", () => {
    expect(PAPERS_AT_A_TIME_HINT).toBe("2 works well with gemma3:27b on a 24 GB card. Also set OLLAMA_NUM_PARALLEL to the same number "
      + "(setx OLLAMA_NUM_PARALLEL 2) and restart Ollama. Use 1 for qwen2.5vl:32b.");
  });
});
