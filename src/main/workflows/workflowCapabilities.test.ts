import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_LEXICAL_CALLSITE_ADAPTER } from "../analysis/languageAnalysisAdapter.js";
import { applyHierarchicalEvent, createHierarchicalExecutionState } from "./hierarchicalWorkflowEngine.js";
import {
  buildWorkflowCapabilityAgentSpec,
  CALLSITE_SEMANTIC_REVIEW_CAPABILITY,
  discoverWorkflowCapabilityRequests,
  executeWorkflowCapability,
  SYMBOL_CONTRACT_CAPABILITY,
  validateWorkflowCapabilityAgentResult,
  workflowCapabilityExecutionMode
} from "./workflowCapabilities.js";

const NOW = "2026-09-01T00:00:00.000Z";

function investigatedState() {
  let state = applyHierarchicalEvent(createHierarchicalExecutionState("复用已有函数", { now: NOW }), {
    type: "plan_accepted",
    requirements: [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "复用行为保持一致",
      acceptance: ["调用参数与 guard 保持一致"],
      dependencies: []
    }],
    occurred_at: NOW
  });
  state = applyHierarchicalEvent(state, {
    type: "requirement_activated",
    requirement_id: "R1",
    occurred_at: NOW
  });
  state = applyHierarchicalEvent(state, {
    type: "phase_started",
    work_unit_id: state.active_work_unit!.id,
    occurred_at: NOW
  });
  return applyHierarchicalEvent(state, {
    type: "phase_passed",
    work_unit_id: state.active_work_unit!.id,
    evidence_refs: ["src/example.js:1"],
    handoff: {
      target_mappings: [{
        target_key: "primary",
        contract_symbol: "target",
        contract_location: "src/example.js:1"
      }, {
        target_key: "duplicate",
        contract_symbol: "target",
        contract_location: "src/example.js:1"
      }],
      reference_analysis: {
        candidates: [{
          target_key: "primary",
          location: "src/example.js:5",
          contract_symbol: "target",
          contract_location: "src/example.js:1"
        }],
        target_selections: [{ target_key: "primary", selected_location: "src/example.js:5" }]
      }
    },
    occurred_at: NOW
  });
}

describe("workflow capabilities", () => {
  it("discovers one stable symbol-contract node per unique callable", () => {
    const first = discoverWorkflowCapabilityRequests(investigatedState(), "R1");
    const second = discoverWorkflowCapabilityRequests(investigatedState(), "R1");

    expect(first).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      id: expect.stringMatching(/^cap:R1:symbol-contract:/),
      capability: SYMBOL_CONTRACT_CAPABILITY,
      input: {
        target_file: "src/example.js",
        symbol: "target",
        adapter_id: "typescript-javascript",
        target_line: 1
      }
    });
  });

  it("creates a separate contract node for the selected entry owner", () => {
    const state = investigatedState();
    const artifact = state.phase_artifacts.at(-1)!;
    const reference = artifact.handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
    };
    Object.assign(reference.candidates[0]!, {
      entry_symbol: "openTarget",
      entry_location: "src/entry.js:4"
    });

    const requests = discoverWorkflowCapabilityRequests(state, "R1")
      .filter((request) => request.capability === SYMBOL_CONTRACT_CAPABILITY);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_file: "src/example.js",
        symbol: "target",
        symbol_role: "destination-contract",
        target_line: 1
      }),
      expect.objectContaining({
        target_file: "src/entry.js",
        symbol: "openTarget",
        symbol_role: "reference-entry",
        target_line: 4
      })
    ]));
  });

  it("expands a Python symbol into an LSP capability only when Pyright is available", () => {
    const previous = process.env.AI_CODER_PYRIGHT_LANGSERVER;
    process.env.AI_CODER_PYRIGHT_LANGSERVER = process.execPath;
    try {
      const state = investigatedState();
      const artifact = state.phase_artifacts.at(-1)!;
      artifact.handoff.target_mappings = [{
        target_key: "python",
        contract_symbol: "target",
        contract_location: "src/example.py:1"
      }];
      artifact.handoff.reference_analysis = {
        candidates: [{
          target_key: "python",
          location: "src/example.py:5",
          contract_symbol: "target",
          contract_location: "src/example.py:1"
        }],
        target_selections: [{ target_key: "python", selected_location: "src/example.py:5" }]
      };

      expect(discoverWorkflowCapabilityRequests(state, "R1")).toEqual([
        expect.objectContaining({
          capability: SYMBOL_CONTRACT_CAPABILITY,
          input: expect.objectContaining({
            target_file: "src/example.py",
            symbol: "target",
            adapter_id: "python-pyright-call-hierarchy"
          })
        })
      ]);
    } finally {
      if (previous === undefined) delete process.env.AI_CODER_PYRIGHT_LANGSERVER;
      else process.env.AI_CODER_PYRIGHT_LANGSERVER = previous;
    }
  });

  it("executes the registered analyzer and returns host-owned evidence", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-capability-"));
    try {
      await writeFile(path.join(projectPath, "example.js"), [
        "export function target(value) {",
        "  return value + 1;",
        "}",
        "export function entry() {",
        "  return target(1);",
        "}"
      ].join("\n"));
      const result = await executeWorkflowCapability(SYMBOL_CONTRACT_CAPABILITY, projectPath, {
        target_file: "example.js",
        symbol: "target",
        adapter_id: "typescript-javascript",
        target_line: 1,
        max_wrapper_depth: 8,
        max_wrapper_symbols: 100
      });

      expect(result.output).toMatchObject({
        target_file: "example.js",
        symbol: "target",
        all_pages_consumed: true,
        wrapper_graph_complete: true,
        reference_accounting: { accounted: true },
        callsite_inventory: {
          total: 1,
          accounted: true,
          entries: [{
            direction: "incoming",
            evidence_ref: "example.js:5",
            review_basis: "host-exact+source",
            destination_definition_excerpt: expect.stringContaining("export function target"),
            definition_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
          }]
        }
      });
      expect(result.evidence_refs).toContain("example.js:1");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("turns entry-function outgoing calls into independently reviewable edges", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-capability-outgoing-"));
    try {
      await writeFile(path.join(projectPath, "route.js"), [
        "export class Target {}",
        "export function openTarget(enabled, navigator) {",
        "  if (enabled) {",
        "    navigator.push({ component: Target, params: { mode: 'safe' } });",
        "  }",
        "}"
      ].join("\n"));
      const result = await executeWorkflowCapability(SYMBOL_CONTRACT_CAPABILITY, projectPath, {
        target_file: "route.js",
        symbol: "openTarget",
        adapter_id: "typescript-javascript",
        target_line: 2,
        max_wrapper_depth: 8,
        max_wrapper_symbols: 100
      });
      const inventory = result.output.callsite_inventory as {
        entries: Array<Record<string, unknown>>;
      };
      expect(inventory.entries).toContainEqual(expect.objectContaining({
        direction: "outgoing",
        evidence_ref: "route.js:4",
        peer_symbol: "navigator.push",
        review_basis: "host-exact+source",
        static_facts: expect.objectContaining({
          arguments: expect.objectContaining({
            "payload.component": "Target",
            "payload.params": "{ mode: 'safe' }"
          }),
          preconditions: ["enabled"]
        })
      }));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps Python/Java callsite coverage when no external language server is installed", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-capability-python-"));
    try {
      await writeFile(path.join(projectPath, "sample.py"), [
        "def target(value):",
        "    return value",
        "",
        "def entry():",
        "    return target(1)"
      ].join("\n"));
      const result = await executeWorkflowCapability(SYMBOL_CONTRACT_CAPABILITY, projectPath, {
        target_file: "sample.py",
        symbol: "target",
        adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        target_line: 1
      });

      expect(result.output).toMatchObject({
        adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        status: "lexical-census-with-semantic-unknowns",
        runtime_verification_required: true,
        callsite_inventory: {
          total: 1,
          accounted: true,
          entries: [{
            evidence_ref: "sample.py:5",
            review_basis: "source+lexical",
            destination_definition_excerpt: expect.stringContaining("def target"),
            definition_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
          }]
        }
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("expands every discovered callsite into an independently retryable AI review node", () => {
    const state = investigatedState();
    const symbolRequest = discoverWorkflowCapabilityRequests(state, "R1")[0]!;
    state.capability_nodes.push({
      id: symbolRequest.id,
      capability: SYMBOL_CONTRACT_CAPABILITY,
      requirement_id: "R1",
      parent_phase: "prepare",
      dependencies: [],
      status: "passed",
      attempt: 1,
      input: symbolRequest.input,
      output: {
        target_file: "src/example.js",
        symbol: "target",
        callsite_inventory: {
          schema_version: 1,
          total: 1,
          accounted: true,
          entries: [{
            callsite_id: "ref:one",
            evidence_ref: "src/example.js:5",
            source_excerpt: "5: target(1)",
            source_digest: "source-digest",
            destination_definition_excerpt: "1: export function target(value) {",
            definition_digest: "definition-digest",
            review_basis: "host-exact+source",
            direction: "incoming",
            peer_symbol: "entry",
            invocation_kind: "call",
            host_fingerprint_digest: "fingerprint",
            static_facts: { arguments: { value: "1" } }
          }]
        }
      },
      evidence_refs: ["src/example.js:1", "src/example.js:5"],
      consecutive_failure_count: 0,
      created_at: NOW,
      updated_at: NOW
    });

    const requests = discoverWorkflowCapabilityRequests(state, "R1");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      id: expect.stringMatching(/^cap:R1:callsite-review:/),
      capability: CALLSITE_SEMANTIC_REVIEW_CAPABILITY,
      dependencies: [symbolRequest.id],
      input: {
        callsite_id: "ref:one",
        evidence_ref: "src/example.js:5",
        definition_digest: "definition-digest",
        host_fingerprint_digest: "fingerprint"
      }
    });
  });

  it("binds an AI callsite review to the host inventory and six semantic dimensions", () => {
    const input = {
      callsite_id: "ref:one",
      target_file: "src/example.js",
      symbol: "target",
      evidence_ref: "src/example.js:5",
      source_excerpt: "5: target(1)",
      destination_definition_excerpt: "1: export function target(value) {",
      definition_digest: "definition-digest",
      review_basis: "host-exact+source",
      host_fingerprint_digest: "fingerprint"
    };
    expect(workflowCapabilityExecutionMode(CALLSITE_SEMANTIC_REVIEW_CAPABILITY)).toBe("agent");
    expect(buildWorkflowCapabilityAgentSpec(CALLSITE_SEMANTIC_REVIEW_CAPABILITY, input).role)
      .toBe("callsite-contract-reviewer");
    const result = validateWorkflowCapabilityAgentResult(
      CALLSITE_SEMANTIC_REVIEW_CAPABILITY,
      input,
      {
        callsite_id: "ref:one",
        disposition: "relevant",
        summary: "entry 调用 target",
        destination: "target@src/example.js",
        invocation: "直接函数调用",
        arguments: ["value=1"],
        preconditions: ["未观察到 guard"],
        context: ["entry 局部上下文"],
        side_effects: ["调用 target"],
        unresolved: [],
        evidence_refs: ["src/example.js:5"],
        definition_digest: "definition-digest",
        host_fingerprint_digest: "fingerprint"
      }
    );
    expect(result.output).toMatchObject({
      callsite_id: "ref:one",
      disposition: "relevant",
      target_file: "src/example.js"
    });
    const withoutHostEchoes = validateWorkflowCapabilityAgentResult(
      CALLSITE_SEMANTIC_REVIEW_CAPABILITY,
      input,
      {
        callsite_id: "ref:one",
        disposition: "relevant",
        summary: "entry 调用 target",
        destination: "target@src/example.js",
        invocation: "直接函数调用",
        arguments: ["value=1"],
        preconditions: ["未观察到 guard"],
        context: ["entry 局部上下文"],
        side_effects: ["调用 target"],
        unresolved: []
      }
    );
    expect(withoutHostEchoes.evidence_refs).toEqual(["src/example.js:5"]);
    expect(withoutHostEchoes.output).toMatchObject({
      evidence_ref: "src/example.js:5",
      definition_digest: "definition-digest",
      host_fingerprint_digest: "fingerprint"
    });
    const hostOwned = validateWorkflowCapabilityAgentResult(
      CALLSITE_SEMANTIC_REVIEW_CAPABILITY,
      input,
      {
        callsite_id: "ref:one",
        disposition: "relevant",
        summary: "wrong evidence",
        destination: "target",
        invocation: "call",
        arguments: ["value=1"],
        preconditions: ["none"],
        context: ["none"],
        side_effects: ["call"],
        unresolved: [],
        evidence_refs: ["src/other.js:1"],
        definition_digest: "definition-digest",
        host_fingerprint_digest: "fingerprint"
      }
    );
    expect(hostOwned.evidence_refs).toEqual(["src/example.js:5"]);
    expect(hostOwned.output).toMatchObject({
      evidence_ref: "src/example.js:5",
      definition_digest: "definition-digest",
      host_fingerprint_digest: "fingerprint"
    });
  });

  it("does not let a discovered capability read outside the registered project", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-capability-scope-"));
    try {
      await expect(executeWorkflowCapability(SYMBOL_CONTRACT_CAPABILITY, projectPath, {
        target_file: "../outside.js",
        symbol: "outside",
        adapter_id: "typescript-javascript"
      })).rejects.toThrow("Blocked path outside project");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
