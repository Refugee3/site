import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_SETTINGS, OllamaBaseUrlSchema, OllamaModelSchema, OllamaNumCtxSchema, OllamaSettingsSchema, pullCommand, visionFromName,
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
