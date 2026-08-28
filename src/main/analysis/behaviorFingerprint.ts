import { createHash } from "node:crypto";
import ts from "typescript";

export const BEHAVIOR_DIMENSIONS = [
  "destination",
  "invocation",
  "arguments",
  "preconditions",
  "context",
  "side_effects"
] as const;

export type BehaviorDimension = typeof BEHAVIOR_DIMENSIONS[number];

export interface BehaviorFingerprintInput {
  reference_id: string;
  target: {
    file: string;
    symbol: string;
  };
  location: {
    file: string;
    line: number;
    column: number;
  };
  kind: "call" | "jsx" | "indirect";
  invocation: string;
  target_path: string | null;
  payload_expression: string | null;
  arguments: Array<{
    parameter: string;
    expression: string;
    provided: boolean;
  }>;
  preconditions: string[];
}

export interface BehaviorFingerprint {
  schema_version: 1;
  source_reference_id: string;
  source_location: string;
  destination: {
    file: string;
    symbol: string;
  };
  invocation: {
    kind: "call" | "jsx" | "indirect";
    callee: string;
    target_path: string | null;
    expression: string;
  };
  arguments: Record<string, string>;
  preconditions: string[];
  context: string[];
  side_effects: string[];
  digest: string;
}

/** Build a stable, source-derived behavior contract for one invocation edge. */
export function buildBehaviorFingerprint(input: BehaviorFingerprintInput): BehaviorFingerprint {
  const invocationExpression = normalizeExpression(input.invocation);
  const callee = invocationCallee(input.kind, input.invocation);
  const args: Record<string, string> = Object.fromEntries(input.arguments
    .filter((argument) => argument.provided)
    .map((argument) => [argument.parameter, normalizeExpression(argument.expression)])
    .sort(([left], [right]) => left.localeCompare(right)));
  const payloadArgs = Object.fromEntries(Object.entries(args)
    .filter(([name]) => name.startsWith("payload.")));
  const semanticArgs = Object.keys(payloadArgs).length > 0 ? payloadArgs : args;
  const preconditions = uniqueSorted(input.preconditions.map(normalizeCondition));
  const context = uniqueSorted([
    ...Object.values(semanticArgs).flatMap(referencedIdentifiers),
    ...preconditions.flatMap((condition) => referencedIdentifiers(
      condition
        .replace(/^after guard:\s*/i, "")
        .replace(/^switch case\s+/i, "")
        .replace(/\bNOT\s*\(/g, "!(")
    ))
  ].filter((identifier) => (
    identifier !== input.target.symbol
    && !callee.split(".").includes(identifier)
  )));
  const sideEffects = uniqueSorted([
    `${input.kind}:${callee}`,
    ...(input.kind === "indirect" && input.target_path
      ? [`delivers:${input.target_path}`]
      : [])
  ]);
  const base = {
    schema_version: 1 as const,
    source_reference_id: input.reference_id,
    source_location: `${input.location.file}:${input.location.line}:${input.location.column}`,
    destination: {
      file: input.target.file,
      symbol: input.target.symbol
    },
    invocation: {
      kind: input.kind,
      callee,
      target_path: input.target_path,
      expression: invocationExpression
    },
    arguments: args,
    preconditions,
    context,
    side_effects: sideEffects
  };
  return {
    ...base,
    digest: createHash("sha256").update(JSON.stringify(base)).digest("hex")
  };
}

export function behaviorDimensionValue(
  fingerprint: BehaviorFingerprint,
  dimension: BehaviorDimension
): unknown {
  switch (dimension) {
    case "destination": return fingerprint.destination;
    case "invocation": return {
      kind: fingerprint.invocation.kind,
      callee: fingerprint.invocation.callee,
      target_path: fingerprint.invocation.target_path
    };
    case "arguments": {
      const payloadEntries = Object.entries(fingerprint.arguments)
        .filter(([name]) => name.startsWith("payload."));
      return payloadEntries.length > 0
        ? Object.fromEntries(payloadEntries.map(([name, value]) => [name.slice("payload.".length), value]))
        : fingerprint.arguments;
    }
    case "preconditions": return fingerprint.preconditions;
    case "context": return fingerprint.context;
    case "side_effects": return fingerprint.side_effects;
  }
}

export function canonicalBehaviorValue(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function normalizeExpression(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const source = ts.createSourceFile(
      "expression.ts",
      `const __value = (${trimmed});`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const statement = source.statements[0];
    if (statement && ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations[0];
      if (declaration?.initializer) {
        return compactWhitespace(unwrapParentheses(declaration.initializer).getText(source));
      }
    }
  } catch {
    // Fall through to conservative whitespace normalization.
  }
  return compactWhitespace(trimmed);
}

function normalizeCondition(value: string): string {
  const trimmed = value.trim();
  const afterGuard = /^after guard:\s*(.*)$/i.exec(trimmed);
  if (afterGuard?.[1]) {
    return `after guard: ${normalizeExpression(afterGuard[1].replace(/\bNOT\s*\(/g, "!("))}`;
  }
  const switchCase = /^switch case\s+(.*)$/i.exec(trimmed);
  if (switchCase?.[1]) return `switch case ${normalizeExpression(switchCase[1])}`;
  if (/^NOT\s*\(/.test(trimmed)) return normalizeExpression(trimmed.replace(/^NOT\s*\(/, "!("));
  return normalizeExpression(trimmed);
}

function invocationCallee(
  kind: BehaviorFingerprintInput["kind"],
  expression: string
): string {
  if (kind === "jsx") {
    return /^<\s*([^\s/>]+)/.exec(expression.trim())?.[1] ?? "<jsx>";
  }
  try {
    const source = ts.createSourceFile(
      "invocation.ts",
      `const __value = (${expression});`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const statement = source.statements[0];
    if (statement && ts.isVariableStatement(statement)) {
      const rawInitializer = statement.declarationList.declarations[0]?.initializer;
      const initializer = rawInitializer ? unwrapParentheses(rawInitializer) : undefined;
      if (initializer && (ts.isCallExpression(initializer) || ts.isNewExpression(initializer))) {
        return compactWhitespace(initializer.expression.getText(source));
      }
    }
  } catch {
    // Fall through to the bounded textual form.
  }
  return compactWhitespace(expression.split("(", 1)[0] ?? expression);
}

function referencedIdentifiers(expression: string): string[] {
  const source = ts.createSourceFile(
    "identifiers.ts",
    `const __value = (${expression});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const identifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueIdentifier(node)) identifiers.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers.filter((identifier) => identifier !== "__value");
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  return true;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
}
