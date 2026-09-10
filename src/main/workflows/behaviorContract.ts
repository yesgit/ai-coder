import { createHash } from "node:crypto";
import { BEHAVIOR_DIMENSIONS, canonicalBehaviorValue, type BehaviorDimension } from "../analysis/behaviorFingerprint.js";
import { PhaseContractError } from "./phaseContract.js";
import type { HierarchicalDiagnostic } from "../../shared/types.js";

export interface BehaviorReference {
  target_key: string;
  /** Only source fingerprints can participate in automatic source equality checks. */
  verification: "source" | "review";
  values: Record<BehaviorDimension, unknown>;
  evidence_refs: string[];
}

export interface CompiledBehaviorObligation {
  id: string;
  dimension: BehaviorDimension;
  decision: "reuse" | "intentional-difference" | "not-applicable";
  reason: string;
  reference: Record<string, unknown>;
  required: Record<string, unknown>;
  evidence_refs: string[];
  changes: Array<{ target_key: string; value: unknown; evidence_refs: string[] }>;
}

export interface CompiledBehaviorContract {
  version: 2;
  source_artifact_id: string;
  references: BehaviorReference[];
  obligations: CompiledBehaviorObligation[];
  digest: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
const evidence = (value: unknown): string[] => strings(value).filter((item) => /:\d+(?:-\d+)?$/.test(item));
const digest = (value: unknown): string => createHash("sha256").update(canonicalBehaviorValue(value)).digest("hex");

/** The provider owns decisions and sparse target changes, never transport envelopes. */
export const behaviorDecisionSchema = {
  type: "object",
  properties: {
    dimension: { type: "string", enum: [...BEHAVIOR_DIMENSIONS] },
    decision: { type: "string", enum: ["reuse", "intentional-difference", "not-applicable"] },
    reason: { type: "string", minLength: 1 },
    changes: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        properties: {
          target_key: { type: "string", minLength: 1 },
          value: { anyOf: [{ type: "object" }, { type: "array", items: { type: "string" } }, { type: "string" }] },
          evidence_refs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
        },
        required: ["target_key", "value", "evidence_refs"], additionalProperties: false
      }
    }
  },
  required: ["dimension", "decision", "reason"],
  allOf: [{
    if: { properties: { decision: { const: "intentional-difference" } }, required: ["decision"] },
    then: { required: ["changes"] },
    else: { not: { required: ["changes"] } }
  }],
  additionalProperties: false
};

function sameShape(reference: unknown, required: unknown): boolean {
  if (reference === null) return typeof required === "string" || record(required)
    || Array.isArray(required) && required.every((item) => typeof item === "string");
  if (Array.isArray(reference)) return Array.isArray(required) && required.every((item) => typeof item === "string");
  if (record(reference)) {
    return record(required)
      && canonicalBehaviorValue(Object.keys(reference).sort()) === canonicalBehaviorValue(Object.keys(required).sort())
      && Object.keys(reference).every((key) => sameShape(reference[key], required[key])
        || reference[key] === null && required[key] === null);
  }
  return typeof reference === typeof required && required !== undefined;
}

/** Pure, atomic compilation. No partial handoff mutation or implicit prose-to-facts conversion. */
export function compileBehaviorContract(
  rawDecisions: unknown,
  references: BehaviorReference[],
  sourceArtifactId: string
): CompiledBehaviorContract {
  const issues: HierarchicalDiagnostic["issues"] = [];
  const rows = Array.isArray(rawDecisions) ? rawDecisions.filter(record) : [];
  const keys = references.map((item) => item.target_key);
  if (!sourceArtifactId || !keys.length || new Set(keys).size !== keys.length
    || references.some((item) => !item.target_key || !evidence(item.evidence_refs).length
      || !["source", "review"].includes(item.verification)
      || BEHAVIOR_DIMENSIONS.some((dimension) => item.values[dimension] === undefined
        || item.verification === "source" && (item.values[dimension] === null
          || (["destination", "invocation", "arguments"].includes(dimension)
            ? !record(item.values[dimension]) : !Array.isArray(item.values[dimension])))))) {
    throw new PhaseContractError({ code: "behavior.reference.invalid", owner_phase: "investigate",
      artifact_id: sourceArtifactId, issues: [{ path: "reference_analysis", message: "参考目标、六维事实或 path:line 证据不完整" }] });
  }
  if (rows.length !== BEHAVIOR_DIMENSIONS.length) issues.push({ path: "behavior_obligations", message: "必须恰好提交六个维度" });
  const obligations: CompiledBehaviorObligation[] = [];
  for (const [index, dimension] of BEHAVIOR_DIMENSIONS.entries()) {
    const path = `behavior_obligations.${dimension}`;
    const matching = rows.filter((item) => item.dimension === dimension);
    if (matching.length !== 1) { issues.push({ path, message: "该维度缺失或重复" }); continue; }
    const row = matching[0]!;
    const decision = row.decision;
    if (decision !== "reuse" && decision !== "intentional-difference" && decision !== "not-applicable") {
      issues.push({ path: `${path}.decision`, message: "无效的行为判断" }); continue;
    }
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!reason) issues.push({ path: `${path}.reason`, message: "必须提供判断依据" });
    const reference = Object.fromEntries(references.map((item) => [item.target_key, item.values[dimension]]));
    const required = { ...reference };
    const refs = references.flatMap((item) => item.evidence_refs);
    const validatedChanges: CompiledBehaviorObligation["changes"] = [];
    // Compatibility adapter for saved v1 drafts only; the provider schema does not expose it.
    let changes = row.changes;
    if (changes === undefined && decision === "intentional-difference" && row.required_behavior !== undefined) {
      let legacy = row.required_behavior;
      try { if (typeof legacy === "string") legacy = JSON.parse(legacy); } catch { /* Reject below. */ }
      if (record(legacy) && legacy.schema_version === 1 && legacy.dimension === dimension && record(legacy.targets)
        && canonicalBehaviorValue(Object.keys(legacy.targets).sort()) === canonicalBehaviorValue([...keys].sort())) {
        changes = Object.entries(legacy.targets).map(([target_key, value]) => ({ target_key, value, evidence_refs: row.evidence_refs }));
      }
    }
    if (decision === "intentional-difference") {
      if (!Array.isArray(changes) || changes.length === 0) {
        issues.push({ path: `${path}.changes`, message: "提交逐目标 {target_key,value,evidence_refs} 差异，不要提交文字信封" });
      } else {
        const seen = new Set<string>();
        for (const [changeIndex, change] of changes.entries()) {
          const changePath = `${path}.changes[${changeIndex}]`;
          if (!record(change) || typeof change.target_key !== "string" || !keys.includes(change.target_key) || seen.has(change.target_key)) {
            issues.push({ path: changePath, message: "目标不存在或重复" }); continue;
          }
          seen.add(change.target_key);
          const validShape = dimension === "arguments" && record(reference[change.target_key])
            ? record(change.value) && Object.values(change.value).every((value) => typeof value === "string")
            : sameShape(reference[change.target_key], change.value);
          if (!validShape) issues.push({ path: `${changePath}.value`, message: "差异值必须保持该维度的字段结构和类型" });
          if (!evidence(change.evidence_refs).length) issues.push({ path: `${changePath}.evidence_refs`, message: "差异必须有 path:line 依据" });
          required[change.target_key] = change.value;
          refs.push(...evidence(change.evidence_refs));
          validatedChanges.push({ target_key: change.target_key, value: change.value, evidence_refs: evidence(change.evidence_refs) });
        }
      }
    } else if (changes !== undefined) {
      issues.push({ path: `${path}.changes`, message: "只有 intentional-difference 可以改变参考行为" });
    }
    if (decision === "not-applicable" && references.some((item) => item.verification === "source"
      && !(Array.isArray(item.values[dimension]) && item.values[dimension].length === 0))) {
      issues.push({ path: `${path}.decision`, message: "已观察到的源码行为不能声明为不适用" });
    }
    obligations.push({ id: `B${index + 1}-${dimension}`, dimension, decision, reason,
      reference, required, evidence_refs: [...new Set(refs)], changes: validatedChanges });
  }
  if (issues.length) throw new PhaseContractError({ code: "behavior.decision.invalid", owner_phase: "prepare", issues });
  const body = { version: 2 as const, source_artifact_id: sourceArtifactId, references, obligations };
  // Clone at the boundary: subsequent provider/context mutations cannot alter the accepted value.
  return JSON.parse(JSON.stringify({ ...body, digest: digest(body) })) as CompiledBehaviorContract;
}

/** The same invariant runs at publication and before any consumer is invoked. */
export function readBehaviorContract(value: unknown, artifactId?: string): CompiledBehaviorContract {
  const invalid = (message: string): never => { throw new PhaseContractError({
    code: "behavior.artifact.invalid", owner_phase: "prepare", artifact_id: artifactId,
    issues: [{ path: "handoff.behavior_contract", message }]
  }); };
  if (!record(value) || value.version !== 2 || !Array.isArray(value.references) || !Array.isArray(value.obligations)) {
    return invalid("需要由 prepare 编译 v2 契约；旧文稿不能作为消费者的可信输入");
  }
  const { digest: storedDigest, ...body } = value;
  if (typeof storedDigest !== "string" || digest(body) !== storedDigest) return invalid("契约摘要不匹配，产物已损坏或被改写");
  try {
    // Recompilation checks coverage, decisions and deltas; digest alone is not validation.
    const rows = value.obligations.map((raw) => {
      if (!record(raw) || !record(raw.required)) throw new Error("义务格式无效");
      return { dimension: raw.dimension, decision: raw.decision, reason: raw.reason,
        ...(raw.decision === "intentional-difference" ? { changes: raw.changes } : {}) };
    });
    const compiled = compileBehaviorContract(rows, value.references as BehaviorReference[], String(value.source_artifact_id ?? ""));
    for (const [index, obligation] of compiled.obligations.entries()) {
      const stored = value.obligations[index];
      if (canonicalBehaviorValue(stored) !== canonicalBehaviorValue(obligation)) throw new Error("冻结事实、差异证据或 ID 不一致");
    }
  } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
  return value as unknown as CompiledBehaviorContract;
}

/** Compatibility projection for existing consumers. It is always derived from the compiled value. */
export function behaviorContractProjection(contract: CompiledBehaviorContract): Record<string, unknown>[] {
  return contract.obligations.map((item) => ({
    id: item.id, dimension: item.dimension, decision: item.decision, reason: item.reason,
    target_keys: contract.references.map((reference) => reference.target_key),
    reference_behavior: canonicalBehaviorValue({ schema_version: 1, dimension: item.dimension, targets: item.reference }),
    required_behavior: canonicalBehaviorValue({ schema_version: 1, dimension: item.dimension, targets: item.required }),
    evidence_refs: item.evidence_refs
  }));
}

/** Restore only provider-owned decisions, never ask a repair role to copy the compiled transport. */
export function behaviorDecisionDraft(handoff: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(handoff);
  const compiled = record(copy.behavior_contract) && copy.behavior_contract.version === 2
    ? copy.behavior_contract : undefined;
  const obligations = Array.isArray(compiled?.obligations) ? compiled.obligations
    : Array.isArray(copy.behavior_obligations) ? copy.behavior_obligations : [];
  copy.behavior_obligations = obligations.filter(record).map((row) => {
    const result: Record<string, unknown> = { dimension: row.dimension, decision: row.decision, reason: row.reason };
    if (row.decision !== "intentional-difference") return result;
    if (row.changes !== undefined) result.changes = row.changes;
    else if (compiled && record(row.required)) {
      result.changes = Object.entries(row.required)
        .filter(([key, value]) => !record(row.reference) || canonicalBehaviorValue(value) !== canonicalBehaviorValue(row.reference[key]))
        .map(([target_key, value]) => ({ target_key, value, evidence_refs: row.evidence_refs }));
    } else {
      let legacy = row.required_behavior;
      try { if (typeof legacy === "string") legacy = JSON.parse(legacy); } catch { /* Retain prose as context below. */ }
      if (record(legacy) && legacy.dimension === row.dimension && record(legacy.targets)) {
        result.changes = Object.entries(legacy.targets).map(([target_key, value]) => ({ target_key, value, evidence_refs: row.evidence_refs }));
      } else {
        // Preserve rejected prose as context, not as a machine-checkable value or a forbidden schema field.
        result.reason = `${String(row.reason ?? "")}；待转换为 changes 的历史差异草稿：${String(row.required_behavior ?? "")}`;
      }
    }
    return result;
  });
  delete copy.behavior_contract;
  delete copy.behavior_contract_version;
  delete copy.reference_application;
  delete copy.satisfaction_evidence;
  return copy;
}
