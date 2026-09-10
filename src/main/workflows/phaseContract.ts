import type { HierarchicalDiagnostic, HierarchicalWorkPhase } from "../../shared/types.js";

/** Carries the producer and field paths through validation, persistence and scheduling. */
export class PhaseContractError extends Error {
  constructor(readonly diagnostic: HierarchicalDiagnostic, displayMessage?: string) {
    super(displayMessage ?? `${diagnostic.code}: ${diagnostic.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "PhaseContractError";
  }
}

export function contractRepairRoute(
  diagnostic: HierarchicalDiagnostic,
  currentPhase: HierarchicalWorkPhase
): "retry" | HierarchicalDiagnostic["owner_phase"] {
  return diagnostic.owner_phase === currentPhase ? "retry" : diagnostic.owner_phase;
}

export function contractFailureIdentity(diagnostic: HierarchicalDiagnostic): string {
  // Artifact revisions and wording can change during repair; neither resets the budget.
  return `contract:${diagnostic.owner_phase}:${diagnostic.code}`;
}
