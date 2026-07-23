import type { HierarchicalExecutionState } from "../../shared/types.js";

export interface HierarchicalPlannerCoverageContract {
  scope_start: number;
  required_sequences: number[];
}

export function buildHierarchicalPlannerCoverageContract(
  taskPrompt: string,
  state: Pick<HierarchicalExecutionState, "alignment_batches">
): HierarchicalPlannerCoverageContract | undefined {
  const scopeStart = extractEnumeratedScopeStart(taskPrompt);
  if (scopeStart === null) return undefined;

  const requiredSequences = new Set<number>();
  for (const batch of state.alignment_batches) {
    for (const finding of batch.findings) {
      for (const sequence of extractBusinessSequenceNumbers(
        `${finding.source_anchor}\n${finding.observable_result}`
      )) {
        if (sequence >= scopeStart) requiredSequences.add(sequence);
      }
    }
  }

  if (requiredSequences.size === 0) return undefined;
  return {
    scope_start: scopeStart,
    required_sequences: [...requiredSequences].sort((left, right) => left - right)
  };
}

export function extractEnumeratedScopeStart(taskPrompt: string): number | null {
  const patterns = [
    /从\s*(?:业务)?序号\s*(\d+)\s*开始/i,
    /序号\s*(\d+)\s*(?:及以后|及之后|以后|之后)/i,
    /from\s+(?:item|number|no\.?|#)?\s*(\d+)\s*(?:onward|onwards|and\s+later)/i
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(taskPrompt)?.[1];
    if (value) return Number(value);
  }
  return null;
}

export function extractBusinessSequenceNumbers(text: string): number[] {
  const sequences = new Set<number>();
  const patterns = [
    /(?:业务)?序号\s*(\d+)/gi,
    /\b(?:item|number|no\.?)\s*#?\s*(\d+)\b/gi,
    /(?:^|\s)#\s*(\d+)\b/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) sequences.add(value);
    }
  }
  return [...sequences];
}
