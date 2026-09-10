import { describe, expect, it } from "vitest";
import { BEHAVIOR_DIMENSIONS } from "../analysis/behaviorFingerprint.js";
import { PhaseContractError, contractFailureIdentity, contractRepairRoute } from "./phaseContract.js";
import { behaviorContractProjection, behaviorDecisionDraft, behaviorDecisionSchema, compileBehaviorContract, readBehaviorContract, type BehaviorReference } from "./behaviorContract.js";

const decisions = () => BEHAVIOR_DIMENSIONS.map((dimension) => ({ dimension, decision: "reuse", reason: "preserve existing behavior" }));
const references = (): BehaviorReference[] => ["one", "two"].map((target_key) => ({
  target_key, verification: "source",
  values: { destination: { file: "target.ts", symbol: "Target" }, invocation: { kind: "call", callee: "push" },
    arguments: { mode: "safe" }, preconditions: ["authenticated"], context: ["navigator"], side_effects: ["navigation"] },
  evidence_refs: ["entry.ts:12"]
}));

describe("behavior contract publication boundary", () => {
  it("removes all host transport fields from the provider schema", () => {
    expect(Object.keys(behaviorDecisionSchema.properties).sort()).toEqual(["changes", "decision", "dimension", "reason"]);
    expect(behaviorDecisionSchema.additionalProperties).toBe(false);
  });

  it("compiles a sparse delta without asking the model to copy unchanged targets or reference facts", () => {
    const rows: Array<Record<string, unknown>> = decisions();
    rows[3] = { dimension: "preconditions", decision: "intentional-difference", reason: "new caller authorization",
      changes: [{ target_key: "two", value: ["authorized"], evidence_refs: ["caller.ts:8"] }],
      reference_behavior: "forged", id: "model-id", target_keys: [] };
    const input = structuredClone(rows);
    const sources = references();
    const contract = compileBehaviorContract(rows, sources, "investigate:1");
    expect(rows).toEqual(input);
    expect(contract.obligations[3]).toMatchObject({ id: "B4-preconditions",
      reference: { one: ["authenticated"], two: ["authenticated"] },
      required: { one: ["authenticated"], two: ["authorized"] } });
    sources[0]!.values.preconditions = ["mutated after publication"];
    expect(readBehaviorContract(contract)).toEqual(contract);
    expect(behaviorContractProjection(contract)).toHaveLength(6);
  });

  it("returns all erroneous dimensions in one diagnostic and leaves the rejected draft intact", () => {
    const rows = decisions().map((row) => ({ ...row, decision: "intentional-difference", required_behavior: "prose" }));
    const before = structuredClone(rows);
    try {
      compileBehaviorContract(rows, references(), "investigate:1");
      expect.fail("must reject the invalid draft");
    } catch (error) {
      expect(error).toBeInstanceOf(PhaseContractError);
      const diagnostic = (error as PhaseContractError).diagnostic;
      expect(diagnostic.owner_phase).toBe("prepare");
      expect(diagnostic.issues).toHaveLength(6);
      expect(diagnostic.issues.every((issue) => issue.path.endsWith(".changes"))).toBe(true);
    }
    expect(rows).toEqual(before);
  });

  it("repairs using a provider-only draft that round-trips without copying transport fields", () => {
    const rows: Array<Record<string, unknown>> = decisions();
    rows[2] = { dimension: "arguments", decision: "intentional-difference", reason: "additional parameter required",
      changes: [{ target_key: "two", value: { mode: "safe", origin: "homepage" }, evidence_refs: ["caller.ts:8"] }] };
    const compiled = compileBehaviorContract(rows, references(), "i:1");
    const draft = behaviorDecisionDraft({ behavior_contract: compiled, behavior_obligations: behaviorContractProjection(compiled) });
    expect(draft).not.toHaveProperty("behavior_contract");
    expect(draft.behavior_obligations).toEqual(rows);
    expect(compileBehaviorContract(draft.behavior_obligations, references(), "i:1").obligations)
      .toEqual(compiled.obligations);
    expect(behaviorDecisionDraft({ behavior_obligations: [{ dimension: "preconditions", decision: "intentional-difference",
      reason: "legacy", required_behavior: "a prose delta" }] }).behavior_obligations)
      .toEqual([{ dimension: "preconditions", decision: "intentional-difference", reason: expect.stringContaining("a prose delta") }]);
  });

  it("rejects missing evidence, duplicate targets, type drift and hidden changes on reuse", () => {
    const invalid = [
      { target_key: "missing", value: [], evidence_refs: ["caller.ts:1"] },
      { target_key: "one", value: "prose guard", evidence_refs: ["caller.ts:1"] },
      { target_key: "one", value: [], evidence_refs: [] }
    ];
    for (const change of invalid) {
      const rows: Array<Record<string, unknown>> = decisions();
      rows[3] = { ...rows[3], decision: "intentional-difference", changes: [change] };
      expect(() => compileBehaviorContract(rows, references(), "i:1")).toThrow(PhaseContractError);
    }
    const rows: Array<Record<string, unknown>> = decisions();
    rows[3]!.changes = [{ target_key: "one", value: [], evidence_refs: ["caller.ts:1"] }];
    expect(() => compileBehaviorContract(rows, references(), "i:1")).toThrow("只有 intentional-difference");
    rows[3]!.decision = "intentional-difference";
    rows[3]!.changes = [...rows[3]!.changes as unknown[], ...rows[3]!.changes as unknown[]];
    expect(() => compileBehaviorContract(rows, references(), "i:1")).toThrow("目标不存在或重复");
  });

  it("represents unobserved facts explicitly and keeps them out of automatic source checks", () => {
    const sources = references();
    sources[0]!.verification = "review";
    sources[0]!.values.preconditions = null;
    const compiled = compileBehaviorContract(decisions(), sources, "i:1");
    expect(readBehaviorContract(compiled).obligations[3]!.reference.one).toBeNull();
    const broken = references();
    broken[0]!.evidence_refs = [];
    expect(() => compileBehaviorContract(decisions(), broken, "i:1")).toThrow("behavior.reference.invalid");
  });

  it("routes a damaged or legacy producer artifact to prepare, regardless of diagnostic wording", () => {
    const contract = compileBehaviorContract(decisions(), references(), "i:1");
    contract.obligations[3]!.required.one = [];
    for (const value of [contract, { behavior_obligations: "legacy" }, null]) {
      try { readBehaviorContract(value, "prepare:1"); expect.fail("must reject"); }
      catch (error) {
        const diagnostic = (error as PhaseContractError).diagnostic;
        expect(diagnostic.artifact_id).toBe("prepare:1");
        expect(contractRepairRoute(diagnostic, "verify")).toBe("prepare");
        expect(contractRepairRoute(diagnostic, "implement")).toBe("prepare");
        expect(contractRepairRoute(diagnostic, "prepare")).toBe("retry");
        expect(contractFailureIdentity({ ...diagnostic, artifact_id: "prepare:2", issues: [] }))
          .toBe(contractFailureIdentity(diagnostic));
      }
    }
  });
});
