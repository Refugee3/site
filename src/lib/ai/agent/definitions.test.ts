import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import { describe, expect, it } from "vitest";
import { GradingOutputSchema, GradingOutputWithoutNotesSchema, KeyExtractionSchema, outputFormat, ScanPagesSchema } from "../schemas";
import {
  AGENT_ROLES,
  agentDefinition,
  definitionHash,
  DEFINITIONS_REVISION,
  environmentDefinition,
  roleModel,
  SUBMIT_TOOL,
  submitToolSchema,
} from "./definitions";
import {
  AGENT_GRADING_SYSTEM_PROMPT, AGENT_KEY_SYSTEM_PROMPT, AGENT_SCAN_SYSTEM_PROMPT, SUBMIT_GRADING_WITHOUT_NOTES,
  SUBMIT_GRADING_WITHOUT_NOTES_DESCRIPTION, SUBMIT_TOOL_DESCRIPTION,
} from "./prompts";
import { testAgentConfig } from "./test-fake";

const cfg = testAgentConfig();
const INSTALL = "a1b2c3d4e5f6";

function customTools(role: (typeof AGENT_ROLES)[number]) {
  return (agentDefinition(role, cfg, INSTALL).params.tools ?? []).filter((t): t is BetaManagedAgentsCustomToolParams => t.type === "custom");
}

describe("agentDefinition", () => {
  it("defines three distinct agents with the right prompts, names and descriptions", () => {
    const defs = AGENT_ROLES.map((role) => agentDefinition(role, cfg, INSTALL));
    expect(new Set(defs.map((d) => d.hash)).size).toBe(3);
    expect(defs.map((d) => d.params.name)).toEqual([
      "PDF Auto-Grader: answer key reader [a1b2c3d4e5f6]",
      "PDF Auto-Grader: paper grader [a1b2c3d4e5f6]",
      "PDF Auto-Grader: scan splitter [a1b2c3d4e5f6]",
    ]);
    expect(defs.map((d) => d.params.system)).toEqual([AGENT_KEY_SYSTEM_PROMPT, AGENT_GRADING_SYSTEM_PROMPT, AGENT_SCAN_SYSTEM_PROMPT]);
    expect(defs[0].params.description).toBe("Reads a teacher's answer-key PDF into gradable items for the PDF Auto-Grader. "
      + "Managed by the app: changes made here are overwritten.");
    expect(defs[1].params.description).toBe("Grades one student's handwritten paper against the answer key for the PDF Auto-Grader. "
      + "Managed by the app: changes made here are overwritten.");
    expect(defs[2].params.description).toBe("Describes scanned pages so the PDF Auto-Grader can split a class's stack into papers. "
      + "Managed by the app: changes made here are overwritten.");
  });

  it("always sets an explicit effort, medium for the scan splitter, which always runs on Sonnet 5.5", () => {
    expect(agentDefinition("extract", cfg, INSTALL).params.model).toEqual({ id: "claude-opus-5-5", effort: "high" });
    expect(agentDefinition("grade", cfg, INSTALL).params.model).toEqual({ id: "claude-opus-5-5", effort: "high" });
    expect(agentDefinition("scan", cfg, INSTALL).params.model).toEqual({ id: "claude-sonnet-5-5", effort: "medium" });
    expect(agentDefinition("grade", testAgentConfig({ effort: "max" }), INSTALL).params.model).toEqual({ id: "claude-opus-5-5", effort: "max" });
  });

  it("gives the answer-key reader and the paper grader the model chosen in Settings, and the scan splitter its own", () => {
    const sonnet = testAgentConfig({ model: "claude-sonnet-5-5" });
    expect(agentDefinition("extract", sonnet, INSTALL).params.model).toEqual({ id: "claude-sonnet-5-5", effort: "high" });
    expect(agentDefinition("grade", sonnet, INSTALL).params.model).toEqual({ id: "claude-sonnet-5-5", effort: "high" });
    expect(agentDefinition("scan", sonnet, INSTALL).params.model).toEqual({ id: "claude-sonnet-5-5", effort: "medium" });
    // Choosing another model changes only the two agents that use it, so only they are updated.
    for (const role of ["extract", "grade"] as const) {
      expect(agentDefinition(role, sonnet, INSTALL).hash).not.toBe(agentDefinition(role, cfg, INSTALL).hash);
    }
    expect(agentDefinition("scan", sonnet, INSTALL).hash).toBe(agentDefinition("scan", cfg, INSTALL).hash);
    expect(roleModel(cfg, "extract")).toBe("claude-opus-5-5");
    expect(roleModel(cfg, "grade")).toBe("claude-opus-5-5");
    expect(roleModel(cfg, "scan")).toBe("claude-sonnet-5-5");
  });

  it("disables every toolset tool by default under the auto policy and enables only bash and read", () => {
    for (const role of AGENT_ROLES) {
      const tools = agentDefinition(role, cfg, INSTALL).params.tools ?? [];
      expect(tools).toHaveLength(role === "grade" ? 3 : 2);
      expect(tools[0]).toEqual({
        type: "agent_toolset_20260401",
        default_config: { enabled: false, permission_policy: { type: "auto" } },
        configs: [
          { name: "bash", enabled: true },
          { name: "read", enabled: true },
          { name: "web_fetch", enabled: false },
          { name: "web_search", enabled: false },
        ],
      });
    }
  });

  it("gives each agent a custom submit tool whose input schema is the structured-output schema", () => {
    const schemas = { extract: KeyExtractionSchema, grade: GradingOutputSchema, scan: ScanPagesSchema };
    for (const role of AGENT_ROLES) {
      const tools = customTools(role);
      expect(tools).toHaveLength(role === "grade" ? 2 : 1);
      expect(tools[0].name).toBe(SUBMIT_TOOL[role]);
      expect(tools[0].description).toBe(SUBMIT_TOOL_DESCRIPTION[role]);
      expect(tools[0].input_schema).toEqual(outputFormat(schemas[role]).schema);
    }
    expect(Object.values(SUBMIT_TOOL)).toEqual(["submit_answer_key", "submit_grading", "submit_scan_pages"]);
  });

  it("gives the grader a second submit tool for gradings without notes", () => {
    const lean = customTools("grade")[1];
    expect(lean.name).toBe(SUBMIT_GRADING_WITHOUT_NOTES);
    expect(lean.description).toBe(SUBMIT_GRADING_WITHOUT_NOTES_DESCRIPTION);
    expect(lean.input_schema).toEqual(outputFormat(GradingOutputWithoutNotesSchema).schema);
    expect(JSON.stringify(lean.input_schema)).not.toMatch(/what_student_did|feedback|teacher_note|teacher_summary/);
  });

  it("uses no skills, MCP servers, multiagent roster or inference geo", () => {
    for (const role of AGENT_ROLES) {
      const params = agentDefinition(role, cfg, INSTALL).params;
      expect(Object.keys(params).sort()).toEqual(["description", "metadata", "model", "name", "system", "tools"]);
      expect(Object.keys(params.model as object).sort()).toEqual(["effort", "id"]);
    }
  });

  it("keeps hashes stable across calls and changes them with the prompt-relevant fields", () => {
    const base = agentDefinition("grade", cfg, INSTALL);
    expect(agentDefinition("grade", testAgentConfig(), INSTALL).hash).toBe(base.hash);
    expect(base.hash).toMatch(/^[0-9a-f]{64}$/);
    // Fields that don't belong to the grader's definition don't change it.
    expect(agentDefinition("grade", testAgentConfig({ scanEffort: "low", budgetCents: { extract: 1, grade: 1, scan: 1 } }), INSTALL).hash)
      .toBe(base.hash);
    expect(agentDefinition("grade", testAgentConfig({ model: "claude-sonnet-5-5" }), INSTALL).hash).not.toBe(base.hash);
    expect(agentDefinition("grade", testAgentConfig({ scanModel: "claude-opus-5-5" }), INSTALL).hash).toBe(base.hash);
    expect(agentDefinition("scan", testAgentConfig({ scanModel: "claude-opus-5-5" }), INSTALL).hash)
      .not.toBe(agentDefinition("scan", cfg, INSTALL).hash);
    expect(agentDefinition("grade", testAgentConfig({ effort: "xhigh" }), INSTALL).hash).not.toBe(base.hash);
    expect(agentDefinition("scan", testAgentConfig({ scanEffort: "low" }), INSTALL).hash).not.toBe(agentDefinition("scan", cfg, INSTALL).hash);
    expect(agentDefinition("grade", cfg, "ffffffffffff").hash).not.toBe(base.hash);
  });

  it("records the definition in metadata without any key material", () => {
    const def = agentDefinition("extract", cfg, INSTALL);
    expect(def.params.metadata).toEqual({ app: "pdf-autograder", role: "extract", install: INSTALL, definition: def.hash.slice(0, 16) });
    expect(JSON.stringify(def.params)).not.toMatch(/sk-ant/);
  });
});

describe("environmentDefinition", () => {
  it("is a cloud environment with limited networking: no hosts, no package managers, no MCP, no packages", () => {
    const def = environmentDefinition(INSTALL);
    expect(def.name).toBe("pdf-autograder-a1b2c3d4e5f6");
    expect(def.params).toEqual({
      name: "pdf-autograder-a1b2c3d4e5f6",
      description: "Workspace template for the PDF Auto-Grader's hosted agent. Created and managed by the app.",
      config: { type: "cloud", networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false } },
      metadata: { app: "pdf-autograder", install: INSTALL },
    });
    expect(def.params.config).not.toHaveProperty("packages");
    expect(def.params.config).not.toHaveProperty("networking.allowed_hosts");
  });

  it("hashes name, description and config", () => {
    const def = environmentDefinition(INSTALL);
    const { name, description, config } = def.params;
    expect(def.hash).toBe(definitionHash({ name, description, config }));
    expect(environmentDefinition(INSTALL).hash).toBe(def.hash);
    expect(environmentDefinition("ffffffffffff").hash).not.toBe(def.hash);
  });
});

describe("definitionHash", () => {
  it("ignores key order at every level and includes the definitions revision", () => {
    expect(definitionHash({ a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(definitionHash({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }));
    expect(definitionHash({ a: [1, 2] })).not.toBe(definitionHash({ a: [2, 1] }));
    expect(DEFINITIONS_REVISION).toBe(1);
  });
});

describe("submitToolSchema", () => {
  it("returns the JSON object schema of each role's output", () => {
    expect(submitToolSchema("grade")).toMatchObject({ type: "object", additionalProperties: false });
    expect(submitToolSchema("scan").required).toEqual(["pages"]);
    expect(submitToolSchema("extract")).not.toHaveProperty("$schema");
  });
});
