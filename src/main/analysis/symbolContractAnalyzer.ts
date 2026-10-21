import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createBoundedTypeScriptProgram, readTypeScriptProjectConfiguration } from "./boundedTypeScriptProgram.js";
import { collectSymbolSourceScope, type SymbolSourceScope } from "./symbolSourceScope.js";

export type SymbolAnalysisSection = "all" | "contract" | "calls" | "wrappers" | "references" | "effects";

export interface AnalyzeSymbolContractInput {
  projectPath: string;
  targetFile: string;
  symbol: string;
  targetLine?: number;
  section?: SymbolAnalysisSection;
  offset?: number;
  limit?: number;
}

export interface EnclosingCallableDefinition {
  symbol: string;
  file: string;
  line: number;
  column: number;
}

/** Prove a receiver is forwarded from the expected member through parameters.
 * This is a bounded source proof, never a spelling/prefix equivalence rule.
 * Every statically resolved caller must agree; missing callers, mutation,
 * defaults, cycles and unsupported expressions fail closed.
 */
export function proveForwardedReceiver(
  projectPath: string,
  targetFile: string,
  line: number,
  observedCallee: string,
  expectedCallee: string
): string[] | undefined {
  const observed = /^(\w+)\.([\w$]+)$/.exec(observedCallee);
  const expected = /^(this(?:\.[\w$]+)+)\.([\w$]+)$/.exec(expectedCallee);
  if (!observed || !expected || observed[2] !== expected[2]) return undefined;
  const project = path.resolve(projectPath);
  const file = path.resolve(project, targetFile);
  assertInsideProject(project, file);
  const { program } = createBoundedTypeScriptProgram(project, discoverProjectSources(project));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) return undefined;
  const calls: ts.CallExpression[] = [];
  for (const unit of program.getSourceFiles()) {
    if (unit.isDeclarationFile || !isInsideProject(project, unit.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(unit);
  }
  const candidates = calls.filter((call) => call.getSourceFile() === source
    && locationOf(call, project).line === line
    && call.expression.getText() === observedCallee);
  if (candidates.length !== 1) return undefined;
  const member = candidates[0]!.expression;
  if (!ts.isPropertyAccessExpression(member)) return undefined;
  const evidence = new Set<string>();
  const trace = (expression: ts.Expression, visited: Set<ts.Symbol>, depth: number): boolean => {
    if (depth > 8) return false;
    if (ts.isParenthesizedExpression(expression)) return trace(expression.expression, visited, depth + 1);
    if (expression.getText() === expected[1]) {
      const loc = locationOf(expression, project);
      evidence.add(`${loc.file}:${loc.line}`);
      return true;
    }
    if (!ts.isIdentifier(expression)) return false;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || visited.has(symbol)) return false;
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer) {
      return trace(declaration.initializer, new Set(visited).add(symbol), depth + 1);
    }
    if (declaration && ts.isBindingElement(declaration) && !declaration.initializer
      && !declaration.dotDotDotToken && ts.isObjectBindingPattern(declaration.parent)) {
      const container = declaration.parent.parent;
      if (ts.isVariableDeclaration(container) && container.initializer
        && ts.isVariableDeclarationList(container.parent)
        && (container.parent.flags & ts.NodeFlags.Const) !== 0) {
        const property = declaration.propertyName ?? declaration.name;
        if (ts.isIdentifier(property)
          && `${container.initializer.getText()}.${property.text}` === expected[1]) {
          const loc = locationOf(declaration, project);
          evidence.add(`${loc.file}:${loc.line}`);
          return true;
        }
      }
      return false;
    }
    if (!declaration || !ts.isParameter(declaration) || declaration.initializer || declaration.dotDotDotToken) return false;
    const owner = declaration.parent;
    if (!ts.isFunctionLike(owner) || !("body" in owner) || !owner.body) return false;
    let mutated = false;
    const inspect = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let root: ts.Node = node.left;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && checker.getSymbolAtLocation(root) === symbol) mutated = true;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && checker.getSymbolAtLocation(node.operand) === symbol) mutated = true;
      ts.forEachChild(node, inspect);
    };
    inspect(owner.body);
    if (mutated) return false;
    const index = owner.parameters.indexOf(declaration);
    const incoming = calls.filter((call) => checker.getResolvedSignature(call)?.declaration === owner);
    if (index < 0 || incoming.length === 0) return false;
    const next = new Set(visited).add(symbol);
    const loc = locationOf(declaration, project);
    evidence.add(`${loc.file}:${loc.line}`);
    return incoming.every((call) => {
      if (call.arguments.some(ts.isSpreadElement)) return false;
      const arg = call.arguments[index];
      return Boolean(arg && trace(arg, next, depth + 1));
    });
  };
  return trace(member.expression, new Set(), 0) ? [...evidence] : undefined;
}

/** Resolve the smallest JS/TS callable whose source span owns a branch/call line. */
export function resolveEnclosingCallableDefinition(
  projectPath: string,
  targetFile: string,
  targetLine: number
): EnclosingCallableDefinition | undefined {
  const project = path.resolve(projectPath);
  const absoluteFile = path.isAbsolute(targetFile)
    ? path.resolve(targetFile)
    : path.resolve(project, targetFile);
  if (absoluteFile !== project && !absoluteFile.startsWith(`${project}${path.sep}`)) {
    throw new Error("目标文件必须位于项目目录内");
  }
  const source = ts.createSourceFile(
    absoluteFile,
    readFileSync(absoluteFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(absoluteFile)
  );
  let selected: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const endLine = source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.end - 1)).line + 1;
    if (targetLine < startLine || targetLine > endLine) return;
    const name = isCallableNode(node) ? callableName(node) : null;
    if (name && name !== "<anonymous>") selected = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!selected) return undefined;
  const symbol = callableName(selected);
  if (!symbol) return undefined;
  const location = locationOf(selected, project);
  return { symbol, ...location };
}

interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

interface ParameterContract {
  name: string;
  type: string;
  required: boolean;
  default_logic: string | null;
  meaning: string | null;
  properties?: ParameterContract[];
}

interface CallArgument {
  parameter: string;
  expression: string;
  inferred_type: string;
  provided: boolean;
}

export interface TargetValueUsage {
  kind: "execution" | "value-transfer" | "possible-execution" | "reference";
  certainty: "confirmed" | "possible";
  evidence_refs: string[];
  unresolved_reason: string | null;
  argument_index?: number;
  call_contexts?: Array<{ callsite: string; invocation: string; preconditions: string[] }>;
}

interface CallSite {
  kind: "call" | "jsx" | "indirect";
  location: SourceLocation;
  enclosing_callable: string | null;
  arguments: CallArgument[];
  provided_parameters: string[];
  omitted_parameters: string[];
  preconditions: string[];
  invocation: string;
  target_path: string | null;
  payload_expression: string | null;
  target_usage: TargetValueUsage;
}

interface OutgoingCall {
  kind: "call" | "new" | "jsx";
  location: SourceLocation;
  enclosing_callable: string | null;
  callee: string;
  invocation: string;
  arguments: CallArgument[];
  preconditions: string[];
}

interface PublicWrapper {
  name: string;
  location: SourceLocation;
  parameters: ParameterContract[];
  target_calls: Array<{
    location: SourceLocation;
    argument_mapping: CallArgument[];
    preconditions: string[];
    target_usage: TargetValueUsage;
  }>;
}

interface NonCallReference {
  location: SourceLocation;
  kind: string;
  expression: string;
  reason?: string;
}

export interface SymbolContractAnalysis {
  target: {
    symbol: string;
    file: string;
    definitions: SourceLocation[];
    kind: string;
  };
  coverage: {
    language: "typescript-javascript";
    analysis_mode: "project-config" | "syntax-fallback";
    configuration_warnings: string[];
    files_scanned: number;
    source_scope: SymbolSourceScope["coverage"];
    total_call_sites: number;
    total_public_wrappers: number;
    total_non_call_references: number;
    total_outgoing_calls: number;
    total_execution_sites: number;
    total_value_transfers: number;
    total_possible_execution_sites: number;
    static_analysis_limits: string[];
    analysis_notes: string[];
  };
  contract?: {
    inputs: ParameterContract[];
    outputs: Array<{ type: string; meaning: string | null }>;
    component_props: ParameterContract[];
    signatures: Array<{
      inputs: ParameterContract[];
      output: { type: string; meaning: string | null };
    }>;
  };
  calls?: {
    items: CallSite[];
    combinations: Array<{
      kind: "call" | "jsx" | "indirect";
      target_usage: Pick<TargetValueUsage, "kind" | "certainty">;
      provided_parameters: string[];
      count: number;
      locations: SourceLocation[];
    }>;
    page: {
      offset: number;
      limit: number;
      returned: number;
      total: number;
      next_offset: number | null;
    };
  };
  wrappers?: {
    items: PublicWrapper[];
    page: {
      offset: number;
      limit: number;
      returned: number;
      total: number;
      next_offset: number | null;
    };
  };
  references?: {
    items: NonCallReference[];
    page: {
      offset: number;
      limit: number;
      returned: number;
      total: number;
      next_offset: number | null;
    };
  };
  effects?: {
    items: OutgoingCall[];
    page: {
      offset: number;
      limit: number;
      returned: number;
      total: number;
      next_offset: number | null;
    };
  };
}

export function analyzeSymbolContract(input: AnalyzeSymbolContractInput): SymbolContractAnalysis {
  const projectPath = path.resolve(input.projectPath);
  const targetFile = path.isAbsolute(input.targetFile)
    ? path.resolve(input.targetFile)
    : path.resolve(projectPath, input.targetFile);
  assertInsideProject(projectPath, targetFile);

  const programBuild = createProgram(projectPath, targetFile, input.symbol);
  const program = programBuild.program;
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(targetFile);
  if (!sourceFile) {
    throw new Error(`目标文件未被 TypeScript 程序加载：${relative(projectPath, targetFile)}`);
  }

  const target = resolveTargetSymbol(sourceFile, input.symbol, checker, input.targetLine);
  const targetDeclarations = target.symbol.getDeclarations() ?? [target.declaration];
  const targetDeclarationSet = new Set(targetDeclarations);
  const targetType = checker.getTypeOfSymbolAtLocation(target.symbol, target.declaration);
  const callSignatures = targetType.getCallSignatures();
  const signatures = callSignatures.length > 0 ? callSignatures : targetType.getConstructSignatures();
  const contract = buildContract(signatures, target.declaration, checker);

  const callSites: CallSite[] = [];
  const wrapperCalls = new Map<ts.Node, CallSite[]>();
  const nonCallReferences: NonCallReference[] = [];
  const indirectCallKeys = new Map<string, CallSite>();
  const traversalLimits = new Set<string>();
  const projectSources = program.getSourceFiles().filter((file) => (
    !file.isDeclarationFile && isInsideProject(projectPath, file.fileName)
  ));

  for (const file of projectSources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        if (symbolMatches(expression, target.symbol, targetDeclarationSet, checker)) {
          const callSite = buildCallSite(node, signatures, checker, projectPath);
          callSites.push(callSite);
          const enclosing = findEnclosingCallable(node);
          if (enclosing && isPublicCallable(enclosing)) {
            const existing = wrapperCalls.get(enclosing) ?? [];
            existing.push(callSite);
            wrapperCalls.set(enclosing, existing);
          }
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (symbolMatches(node.tagName, target.symbol, targetDeclarationSet, checker)) {
          const callSite = buildJsxCallSite(node, contract.inputs, checker, projectPath);
          callSites.push(callSite);
          const enclosing = findEnclosingCallable(node);
          if (enclosing && isPublicCallable(enclosing)) {
            const existing = wrapperCalls.get(enclosing) ?? [];
            existing.push(callSite);
            wrapperCalls.set(enclosing, existing);
          }
        }
      } else if (isReferenceNode(node) && symbolMatches(node, target.symbol, targetDeclarationSet, checker)) {
        if (!isDefinitionName(node, targetDeclarationSet) && !isDirectInvocationReference(node)) {
          const referenceKind = classifyNonCallReference(node);
          const lifted = referenceKind === "import" || referenceKind === "export"
            ? { calls: [], unresolved: [] }
            : liftReferenceToIndirectCalls(node, signatures, contract.inputs, checker, projectSources, projectPath, traversalLimits);
          nonCallReferences.push(...lifted.unresolved);
          if (lifted.calls.length > 0) {
            for (const callSite of lifted.calls) {
              const key = [
                callSite.location.file,
                callSite.location.line,
                callSite.location.column,
                callSite.target_path,
                callSite.payload_expression,
                callSite.target_usage.argument_index
              ].join("\0");
              const previous = indirectCallKeys.get(key);
              if (previous) {
                previous.target_usage.evidence_refs = [...new Set([
                  ...previous.target_usage.evidence_refs, ...callSite.target_usage.evidence_refs
                ])];
                previous.target_usage.call_contexts = [...new Map([
                  ...(previous.target_usage.call_contexts ?? []), ...(callSite.target_usage.call_contexts ?? [])
                ].map((context) => [JSON.stringify(context), context])).values()];
                if (callSite.target_usage.certainty === "possible") {
                  previous.target_usage.certainty = "possible";
                  if (previous.target_usage.kind === "execution") previous.target_usage.kind = "possible-execution";
                }
                previous.target_usage.unresolved_reason = [...new Set([
                  previous.target_usage.unresolved_reason, callSite.target_usage.unresolved_reason
                ].filter(Boolean))].join("；") || null;
                continue;
              }
              indirectCallKeys.set(key, callSite);
              callSites.push(callSite);
              const enclosing = findEnclosingCallableAtLocation(
                projectSources,
                callSite.location,
                projectPath
              );
              if (enclosing && isPublicCallable(enclosing)) {
                const existing = wrapperCalls.get(enclosing) ?? [];
                existing.push(callSite);
                wrapperCalls.set(enclosing, existing);
              }
            }
          } else if (lifted.unresolved.length === 0) {
            nonCallReferences.push({
              location: locationOf(node, projectPath),
              kind: referenceKind,
              expression: node.getText().slice(0, 300)
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  callSites.sort(compareLocations);
  nonCallReferences.sort(compareLocations);
  const outgoingCalls = collectOutgoingCalls(
    targetDeclarations,
    checker,
    projectPath
  ).sort(compareLocations);
  const wrappers = [...wrapperCalls.entries()]
    .map(([node, calls]) => buildPublicWrapper(node, calls, checker, projectPath))
    .sort((a, b) => compareSourceLocations(a.location, b.location));

  const section = input.section ?? "all";
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const pagedCalls = callSites.slice(offset, offset + limit);
  const result: SymbolContractAnalysis = {
    target: {
      symbol: input.symbol,
      file: relative(projectPath, targetFile),
      definitions: targetDeclarations.map((declaration) => locationOf(declaration, projectPath)),
      kind: describeDeclarationKind(target.declaration)
    },
    coverage: {
      language: "typescript-javascript",
      analysis_mode: programBuild.mode,
      configuration_warnings: programBuild.warnings,
      files_scanned: projectSources.length,
      source_scope: programBuild.sourceScope,
      total_call_sites: callSites.length,
      total_public_wrappers: wrappers.length,
      total_non_call_references: nonCallReferences.length,
      total_outgoing_calls: outgoingCalls.length,
      total_execution_sites: callSites.filter((site) => site.target_usage.kind === "execution").length,
      total_value_transfers: callSites.filter((site) => site.target_usage.kind === "value-transfer").length,
      total_possible_execution_sites: callSites.filter((site) => site.target_usage.kind === "possible-execution").length,
      static_analysis_limits: [
        ...programBuild.sourceScope.limitations,
        ...traversalLimits,
        ...(programBuild.mode === "syntax-fallback" ? [
            "未加载有效 TypeScript 项目配置，符号解析采用语法回退。",
            ...programBuild.warnings
          ] : [])
      ],
      analysis_notes: [
        "调用范围限定为已索引的项目内 JS/TS 源码及静态可解析的模块关系；不包含项目外调用方。",
        "反射、字符串注册、运行时依赖注入和外部包调用无法由静态分析证明完整。",
        "target_usage 区分执行、值传递和候选执行；未追通的回调或函数值流向保留在 references 或 unresolved_reason 中。",
        "preconditions 只包含可从局部控制流直接观察到的条件，不等同于完整业务前置条件。"
      ]
    }
  };

  if (section === "all" || section === "contract") {
    result.contract = contract;
  }
  if (section === "all" || section === "calls") {
    result.calls = {
      items: pagedCalls,
      combinations: groupCombinations(callSites),
      page: {
        offset,
        limit,
        returned: pagedCalls.length,
        total: callSites.length,
        next_offset: offset + pagedCalls.length < callSites.length ? offset + pagedCalls.length : null
      }
    };
  }
  if (section === "all" || section === "wrappers") {
    const items = section === "wrappers" ? wrappers.slice(offset, offset + limit) : wrappers;
    result.wrappers = {
      items,
      page: buildPage(offset, limit, items.length, wrappers.length)
    };
  }
  if (section === "all" || section === "references") {
    const items = section === "references"
      ? nonCallReferences.slice(offset, offset + limit)
      : nonCallReferences;
    result.references = {
      items,
      page: buildPage(offset, limit, items.length, nonCallReferences.length)
    };
  }
  if (section === "all" || section === "effects") {
    const items = section === "effects"
      ? outgoingCalls.slice(offset, offset + limit)
      : outgoingCalls;
    result.effects = {
      items,
      page: buildPage(offset, limit, items.length, outgoingCalls.length)
    };
  }
  return result;
}

function createProgram(
  projectPath: string,
  targetFile: string,
  symbol: string
): {
  program: ts.Program;
  mode: "project-config" | "syntax-fallback";
  warnings: string[];
  sourceScope: SymbolSourceScope["coverage"];
} {
  const sourceFiles = discoverProjectSources(projectPath);
  const configuration = readTypeScriptProjectConfiguration(projectPath);
  const scope = collectSymbolSourceScope(
    projectPath, sourceFiles, targetFile, symbol, configuration.options
  );
  return {
    ...createBoundedTypeScriptProgram(projectPath, scope.files),
    sourceScope: scope.coverage
  };
}

function scriptKindForFile(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function discoverProjectSources(projectPath: string): string[] {
  return ts.sys.readDirectory(
    projectPath,
    [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    ["**/node_modules/**", "**/dist/**", "**/build/**", "**/release/**", "**/.git/**"]
  );
}

function resolveTargetSymbol(
  sourceFile: ts.SourceFile,
  requestedName: string,
  checker: ts.TypeChecker,
  targetLine?: number
): { symbol: ts.Symbol; declaration: ts.Declaration } {
  const candidates: Array<{ symbol: ts.Symbol; declaration: ts.Declaration }> = [];
  const sourceSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = sourceSymbol
    ? checker.getExportsOfModule(sourceSymbol).find((item) => item.getName() === requestedName)
    : undefined;
  if (exported) {
    const resolved = resolveAlias(exported, checker);
    const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
    if (declaration) candidates.push({ symbol: resolved, declaration });
  }

  const visit = (node: ts.Node): void => {
    const nameNode = declarationNameNode(node);
    if (nameNode && nameNode.getText(sourceFile) === requestedName) {
      const symbol = checker.getSymbolAtLocation(nameNode);
      if (symbol) {
        const resolved = resolveAlias(symbol, checker);
        const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
        if (declaration) candidates.push({ symbol: resolved, declaration });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const uniqueCandidates = dedupeBy(candidates, (candidate) => (
    `${candidate.declaration.getSourceFile().fileName}:${candidate.declaration.pos}:${candidate.symbol.getName()}`
  ));
  const unique = targetLine
    ? uniqueCandidates.filter((candidate) => declarationContainsLine(candidate.declaration, targetLine))
    : uniqueCandidates;
  if (unique.length === 0) {
    const suffix = targetLine ? `（定义行 ${targetLine}）` : "";
    throw new Error(`在 ${sourceFile.fileName} 中找不到符号 ${requestedName}${suffix}`);
  }
  if (unique.length > 1) {
    const locations = unique.map((candidate) => {
      const start = candidate.declaration.getSourceFile().getLineAndCharacterOfPosition(candidate.declaration.getStart());
      return `${start.line + 1}:${start.character + 1}`;
    });
    throw new Error(`符号 ${requestedName} 不唯一，候选位置：${locations.join(", ")}`);
  }
  return unique[0];
}

function buildContract(
  signatures: readonly ts.Signature[],
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): NonNullable<SymbolContractAnalysis["contract"]> {
  const signature = signatures[0];
  const inputs = signature
    ? signature.getParameters().map((parameter) => parameterContract(parameter, checker, declaration))
    : [];
  const outputs = signatures.map((item) => ({
    type: checker.typeToString(item.getReturnType(), declaration, ts.TypeFormatFlags.NoTruncation),
    meaning: documentationOf(symbolOfDeclaration(item.declaration, checker), checker)
  }));
  const classComponentProps = classComponentPropsContract(declaration, checker);
  const componentProps = classComponentProps.length > 0
    ? classComponentProps
    : looksLikeComponent(declaration, signatures, checker) && inputs.length === 1
      ? (inputs[0].properties ?? [])
      : [];
  const effectiveInputs = inputs.length > 0
    ? inputs
    : classComponentProps.length > 0
      ? [{
          name: "props",
          type: classComponentPropsType(declaration, checker) ?? "<unknown>",
          required: true,
          default_logic: null,
          meaning: null,
          properties: classComponentProps
        }]
      : [];
  const signatureContracts = signatures.map((signature) => ({
    inputs: signature.getParameters().map((parameter) => parameterContract(parameter, checker, declaration)),
    output: {
      type: checker.typeToString(signature.getReturnType(), declaration, ts.TypeFormatFlags.NoTruncation),
      meaning: documentationOf(symbolOfDeclaration(signature.declaration, checker), checker)
    }
  }));
  return {
    inputs: effectiveInputs,
    outputs,
    component_props: componentProps,
    signatures: signatureContracts
  };
}

function classComponentPropsContract(
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): ParameterContract[] {
  const type = classComponentPropsTypeNode(declaration);
  if (!type) return [];
  const propsType = checker.getTypeFromTypeNode(type);
  return checker.getPropertiesOfType(propsType)
    .slice(0, 100)
    .map((property) => parameterContract(property, checker, declaration));
}

function classComponentPropsType(
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string | null {
  const type = classComponentPropsTypeNode(declaration);
  return type
    ? checker.typeToString(checker.getTypeFromTypeNode(type), declaration, ts.TypeFormatFlags.NoTruncation)
    : null;
}

function classComponentPropsTypeNode(declaration: ts.Declaration): ts.TypeNode | null {
  if (!ts.isClassDeclaration(declaration)) return null;
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const heritageType of clause.types) {
      const baseName = heritageType.expression.getText();
      if (!/(?:^|\.)(?:Component|PureComponent)$/.test(baseName)) continue;
      if (heritageType.typeArguments?.[0]) return heritageType.typeArguments[0];
    }
  }
  return null;
}

function parameterContract(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  context: ts.Node,
  seen = new Set<ts.Symbol>(),
  depth = 0
): ParameterContract {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration ?? context);
  const optional = Boolean(symbol.flags & ts.SymbolFlags.Optional)
    || Boolean(declaration && "questionToken" in declaration && declaration.questionToken)
    || Boolean(declaration && ts.isParameter(declaration) && declaration.dotDotDotToken);
  const defaultLogic = initializerText(declaration);
  const result: ParameterContract = {
    name: symbol.getName(),
    type: checker.typeToString(type, declaration ?? context, ts.TypeFormatFlags.NoTruncation),
    required: !optional && !defaultLogic,
    default_logic: defaultLogic,
    meaning: documentationOf(symbol, checker)
  };

  if (depth < 2 && !seen.has(symbol) && shouldExpandProperties(type)) {
    seen.add(symbol);
    const defaults = collectBindingDefaults(declaration);
    const properties = checker.getPropertiesOfType(type).slice(0, 100).map((property) => {
      const item = parameterContract(property, checker, declaration ?? context, seen, depth + 1);
      if (!item.default_logic && defaults.has(item.name)) {
        item.default_logic = defaults.get(item.name) ?? null;
        item.required = false;
      }
      return item;
    });
    if (properties.length > 0) result.properties = properties;
  }
  return result;
}

function buildCallSite(
  node: ts.CallExpression | ts.NewExpression,
  targetSignatures: readonly ts.Signature[],
  checker: ts.TypeChecker,
  projectPath: string
): CallSite {
  const resolved = checker.getResolvedSignature(node);
  const signature = targetSignatures.find((item) => item.declaration === resolved?.declaration)
    ?? targetSignatures[0] ?? resolved;
  const parameters = signature?.getParameters() ?? [];
  const args = node.arguments ?? ts.factory.createNodeArray();
  const argumentsList: CallArgument[] = [];

  const objectArgument = args[0];
  const objectParameter = parameters[0];
  const objectParameterType = objectParameter
    ? checker.getTypeOfSymbolAtLocation(objectParameter, objectParameter.valueDeclaration ?? node)
    : undefined;
  const objectProperties = objectParameterType ? checker.getPropertiesOfType(objectParameterType) : [];
  if (
    parameters.length === 1
    && args.length === 1
    && objectArgument
    && ts.isObjectLiteralExpression(objectArgument)
    && objectProperties.length > 0
  ) {
    for (const property of objectArgument.properties) {
      if (ts.isSpreadAssignment(property)) {
        argumentsList.push({
          parameter: "...spread",
          expression: property.expression.getText().slice(0, 500),
          inferred_type: checker.typeToString(checker.getTypeAtLocation(property.expression), property.expression),
          provided: true
        });
        continue;
      }
      const name = property.name?.getText() ?? "<unknown>";
      const expression = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      argumentsList.push({
        parameter: name,
        expression: expression?.getText().slice(0, 500) ?? property.getText().slice(0, 500),
        inferred_type: expression
          ? checker.typeToString(checker.getTypeAtLocation(expression), expression, ts.TypeFormatFlags.NoTruncation)
          : "<unknown>",
        provided: true
      });
    }
    const provided = new Set(argumentsList.map((item) => item.parameter));
    for (const property of objectProperties) {
      if (!provided.has(property.getName())) {
        argumentsList.push({
          parameter: property.getName(),
          expression: "<omitted>",
          inferred_type: "<omitted>",
          provided: false
        });
      }
    }
  } else {
    for (let index = 0; index < Math.max(parameters.length, args.length); index += 1) {
      const parameter = parameters[index];
      const argument = args[index];
      argumentsList.push({
        parameter: parameter?.getName() ?? `arg${index + 1}`,
        expression: argument?.getText().slice(0, 500) ?? "<omitted>",
        inferred_type: argument
          ? checker.typeToString(checker.getTypeAtLocation(argument), argument, ts.TypeFormatFlags.NoTruncation)
          : "<omitted>",
        provided: Boolean(argument)
      });
    }
  }

  return {
    kind: "call",
    location: locationOf(node, projectPath),
    enclosing_callable: callableName(findEnclosingCallable(node)),
    arguments: argumentsList,
    provided_parameters: argumentsList.filter((item) => item.provided).map((item) => item.parameter),
    omitted_parameters: argumentsList.filter((item) => !item.provided).map((item) => item.parameter),
    preconditions: collectPreconditions(node),
    invocation: node.getText().slice(0, 1_000),
    target_path: null,
    payload_expression: null,
    target_usage: { kind: "execution", certainty: "confirmed", evidence_refs: [evidenceRef(node, projectPath)], unresolved_reason: null }
  };
}

function buildJsxCallSite(
  node: ts.JsxOpeningLikeElement,
  inputs: ParameterContract[],
  checker: ts.TypeChecker,
  projectPath: string
): CallSite {
  const props = inputs.length === 1 ? (inputs[0].properties ?? []) : inputs;
  const attributes = node.attributes.properties;
  const argumentsList: CallArgument[] = attributes.map((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) {
      return {
        parameter: "...spread",
        expression: attribute.expression.getText().slice(0, 500),
        inferred_type: checker.typeToString(checker.getTypeAtLocation(attribute.expression), attribute.expression),
        provided: true
      };
    }
    const initializer = attribute.initializer;
    const expression = !initializer
      ? "true"
      : ts.isStringLiteral(initializer)
        ? JSON.stringify(initializer.text)
        : ts.isJsxExpression(initializer)
          ? initializer.expression?.getText().slice(0, 500) ?? "{undefined}"
          : initializer.getText().slice(0, 500);
    const jsxExpression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
    const typeNode = jsxExpression ?? initializer ?? attribute;
    return {
      parameter: attribute.name.getText(),
      expression,
      inferred_type: checker.typeToString(checker.getTypeAtLocation(typeNode), typeNode),
      provided: true
    };
  });
  if (ts.isJsxOpeningElement(node) && node.parent.children.length > 0) {
    argumentsList.push({
      parameter: "children",
      expression: `<${node.parent.children.length} JSX children>`,
      inferred_type: "ReactNode",
      provided: true
    });
  }
  const provided = new Set(argumentsList.map((item) => item.parameter));
  return {
    kind: "jsx",
    location: locationOf(node, projectPath),
    enclosing_callable: callableName(findEnclosingCallable(node)),
    arguments: argumentsList,
    provided_parameters: [...provided],
    omitted_parameters: props.filter((prop) => !provided.has(prop.name)).map((prop) => prop.name),
    preconditions: collectPreconditions(node),
    invocation: node.getText().slice(0, 1_000),
    target_path: null,
    payload_expression: null,
    target_usage: { kind: "execution", certainty: "confirmed", evidence_refs: [evidenceRef(node, projectPath)], unresolved_reason: null }
  };
}

interface LiftState {
  node: ts.Node;
  payloadNode: ts.Expression;
  path: string[];
  depth: number;
  possible: boolean;
  reason: string | null;
  evidence: string[];
  returns: Array<{ call: ts.CallExpression | ts.NewExpression; owner: SourceCallable; parameter: ts.ParameterDeclaration }>;
}

type SourceCallable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  | ts.MethodDeclaration | ts.ConstructorDeclaration;

function evidenceRef(node: ts.Node, projectPath: string): string {
  const location = locationOf(node, projectPath);
  return `${location.file}:${location.line}`;
}

/**
 * Lift a symbol used as data to the call that consumes that data.
 *
 * This is deliberately API agnostic. It covers components stored in route
 * objects, callbacks registered in options, dependency-injection descriptors,
 * command tables and any equivalent "value eventually passed to a call"
 * shape. A bounded alias traversal handles the common case where the payload
 * is first assigned to a local/module variable.
 */
function liftReferenceToIndirectCalls(
  reference: ts.Identifier | ts.PropertyAccessExpression,
  signatures: readonly ts.Signature[],
  inputs: ParameterContract[],
  checker: ts.TypeChecker,
  projectSources: ts.SourceFile[],
  projectPath: string,
  traversalLimits: Set<string>
): { calls: CallSite[]; unresolved: NonCallReference[] } {
  const queue: LiftState[] = [{
    node: reference,
    payloadNode: reference,
    path: [],
    depth: 0,
    possible: false,
    reason: null,
    evidence: [evidenceRef(reference, projectPath)],
    returns: []
  }];
  const seen = new Set<string>();
  const results: CallSite[] = [];
  const unresolved: NonCallReference[] = [];
  const invocations: Array<ts.CallExpression | ts.NewExpression> = [];
  for (const source of projectSources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) invocations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const implementation = (call: ts.CallExpression | ts.NewExpression): SourceCallable | undefined => {
    const stableCallee = (expression: ts.Expression, visited = new Set<ts.Symbol>()): boolean => {
      expression = unwrapValue(expression);
      if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return true;
      if (ts.isPropertyAccessExpression(expression)) return true; // Method receivers remain uncertain below.
      if (!ts.isIdentifier(expression)) return false;
      const symbol = checker.getSymbolAtLocation(expression);
      if (!symbol || visited.has(symbol) || visited.size >= 12 || reassigned(symbol)) return false;
      const declaration = resolveAlias(symbol, checker).valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return isConstBinding(declaration) && stableCallee(declaration.initializer, new Set(visited).add(symbol));
      }
      return Boolean(declaration && isSourceCallable(declaration));
    };
    if (!stableCallee(call.expression)) return undefined;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (declaration && isSourceCallable(declaration) && declaration.body) return declaration;
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const symbol = checker.getSymbolAtLocation(callee);
    return symbol && resolveAlias(symbol, checker).declarations?.find((node): node is SourceCallable => (
      isSourceCallable(node) && Boolean(node.body)
    ));
  };
  const references = (symbol: ts.Symbol): Array<ts.Identifier | ts.PropertyAccessExpression> => (
    findSymbolReferences(symbol, checker, projectSources)
  );
  const reassigned = (symbol: ts.Symbol): boolean => references(symbol).some(isBindingWrite);
  const rootSymbol = valueSymbol(reference, checker);
  // This proof is about every statically visible binding of a callback slot,
  // not just the call which happened to lead this traversal into its body.
  const definiteValue = (expression: ts.Expression, visited = new Set<ts.Symbol>()): boolean => {
    expression = unwrapValue(expression);
    const symbol = valueSymbol(expression, checker);
    if (!symbol || !rootSymbol || visited.has(symbol) || visited.size >= 12) return false;
    if (resolveAlias(symbol, checker) === resolveAlias(rootSymbol, checker)) return true;
    const declaration = resolveAlias(symbol, checker).valueDeclaration;
    const next = new Set(visited).add(symbol);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && isConstBinding(declaration) && !reassigned(symbol)) {
      return definiteValue(declaration.initializer, next);
    }
    if (declaration && ts.isParameter(declaration) && ts.isIdentifier(declaration.name)
      && !declaration.dotDotDotToken && isSourceCallable(declaration.parent) && !reassigned(symbol)) {
      const owner = declaration.parent;
      const index = owner.parameters.indexOf(declaration);
      const callers = invocations.filter((call) => implementation(call) === owner);
      return callers.length > 0 && callers.every((call) => {
        const argument = call.arguments?.[index];
        return !call.arguments?.some(ts.isSpreadElement) && Boolean(argument && definiteValue(argument, next));
      });
    }
    return false;
  };
  const enqueue = (state: LiftState, node: ts.Node, patch: Partial<LiftState> = {}): void => {
    queue.push({ ...state, ...patch, node, depth: state.depth + 1,
      evidence: [...new Set([...state.evidence, ...(patch.evidence ?? []), evidenceRef(node, projectPath)])] });
  };
  const followBinding = (state: LiftState, name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;
    const declaration = symbol.valueDeclaration;
    const mutable = reassigned(symbol) || Boolean(declaration && ts.isVariableDeclaration(declaration) && !isConstBinding(declaration));
    for (const use of references(symbol)) {
      if (use === name || isBindingWrite(use)) continue;
      enqueue(state, use, mutable ? {
        possible: true, reason: "函数值绑定可变或存在重新赋值，无法证明执行时仍为目标函数"
      } : {});
    }
  };
  const retainUnknown = (state: LiftState, reason: string): void => {
    unresolved.push({ location: locationOf(state.node, projectPath), kind: "unresolved-value-flow",
      expression: state.node.getText().slice(0, 300), reason });
  };
  const maxDepth = 12;
  const maxStates = 100;

  while (queue.length > 0 && seen.size < maxStates) {
    const state = queue.shift()!;
    if (state.depth > maxDepth) {
      const location = locationOf(reference, projectPath);
      traversalLimits.add(`间接引用追踪达到最大深度 ${maxDepth}：${location.file}:${location.line}`);
      continue;
    }
    const stateKey = [
      state.node.getSourceFile().fileName,
      state.node.pos,
      state.node.end,
      state.path.join("."),
      state.possible,
      state.returns.map((context) => `${context.call.getSourceFile().fileName}:${context.call.pos}`).join("/")
    ].join(":");
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);
    const parent = state.node.parent;
    if (!parent) continue;

    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && parent.expression === state.node && state.path.length === 0) {
      const site = buildCallSite(parent, signatures, checker, projectPath);
      site.target_usage = {
        kind: state.possible ? "possible-execution" : "execution",
        certainty: state.possible ? "possible" : "confirmed",
        evidence_refs: [...new Set([...state.evidence, evidenceRef(parent, projectPath)])],
        unresolved_reason: state.possible ? state.reason : null,
        call_contexts: state.returns.map((context) => ({ callsite: evidenceRef(context.call, projectPath),
          invocation: context.call.getText().slice(0, 1_000), preconditions: collectPreconditions(context.call) }))
      };
      results.push(site);
      continue;
    }
    if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))
      && parent.tagName === state.node && state.path.length === 0) {
      const site = buildJsxCallSite(parent, inputs, checker, projectPath);
      site.target_usage = { kind: state.possible ? "possible-execution" : "execution",
        certainty: state.possible ? "possible" : "confirmed",
        evidence_refs: [...new Set([...state.evidence, evidenceRef(parent, projectPath)])],
        unresolved_reason: state.possible ? state.reason : null };
      results.push(site);
      continue;
    }

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && Boolean(parent.arguments?.includes(state.node as ts.Expression))
    ) {
      const transfer = buildIndirectCallSite(
        parent,
        state.payloadNode,
        state.path,
        checker,
        projectPath
      );
      transfer.target_usage.evidence_refs = [...new Set([...state.evidence, evidenceRef(parent, projectPath)])];
      transfer.target_usage.certainty = state.possible ? "possible" : "confirmed";
      if (state.possible) transfer.target_usage.unresolved_reason = state.reason;
      results.push(transfer);
      const owner = implementation(parent);
      const index = parent.arguments?.indexOf(state.node as ts.Expression) ?? -1;
      transfer.target_usage.argument_index = index;
      const parameter = owner?.parameters[index];
      const callee = unwrapValue(parent.expression);
      const dynamicReceiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        || Boolean(owner && ts.isMethodDeclaration(owner));
      const dynamicBody = Boolean(owner && hasDynamicParameterAccess(owner));
      if (owner && parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken
        && !parent.arguments?.some(ts.isSpreadElement)) {
        const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
        const exact = !state.possible && state.path.length === 0 && definiteValue(parameter.name)
          && !dynamicReceiver && !dynamicBody;
        if (!state.possible) transfer.target_usage.unresolved_reason = dynamicReceiver
          ? "动态接收者可能替换实际实现，参数的最终用途尚未证明"
          : dynamicBody ? "函数通过 arguments 或 eval 动态访问参数，参数的使用或改写尚未证明" : null;
        if (dynamicReceiver) enqueue(state, parent, { possible: true,
          reason: "动态接收者可能返回其他函数值，返回值的同一性尚未证明" });
        if (parameterSymbol) {
          for (const use of references(parameterSymbol)) {
            if (use === parameter.name || isBindingWrite(use)) continue;
            enqueue(state, use, {
              possible: !exact,
              reason: exact ? null : "回调参数存在其他来源、可变状态或动态接收者，执行目标未能唯一确认",
              returns: [...state.returns, { call: parent, owner, parameter }]
            });
          }
        }
      } else {
        // An unknown factory may return a carrier, but passing a value into it
        // is not proof of what comes back. Preserve HOC/navigation discovery
        // as a candidate with explicit uncertainty.
        enqueue(state, parent, { possible: true,
          reason: "工厂或注册函数的实现不可解析，无法证明返回值仍承载目标函数" });
      }
      continue;
    }

    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === state.node && state.path.length > 0) {
      const property = ts.isPropertyAccessExpression(parent) ? parent.name.text
        : parent.argumentExpression && ts.isStringLiteralLike(parent.argumentExpression)
          ? parent.argumentExpression.text : null;
      if (property === state.path[0]) {
        enqueue(state, parent, { path: state.path.slice(1), possible: true,
          reason: "对象属性中的函数值可能被改写，执行目标需要进一步验证" });
      } else if (property === null) {
        retainUnknown(state, "动态属性访问无法确定目标函数的去向");
      }
      continue;
    }

    const lifted = liftThroughContainer(parent, state);
    if (lifted) {
      enqueue(state, lifted.node, lifted);
      continue;
    }

    if (
      ts.isVariableDeclaration(parent)
      && parent.initializer
      && containsNode(parent.initializer, state.node)
      && ts.isIdentifier(parent.name)
    ) {
      followBinding(state, parent.name);
      continue;
    }

    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === state.node && ts.isIdentifier(parent.left)) {
      followBinding({ ...state, possible: true,
        reason: "目标通过可变赋值传递，执行时的函数值需要进一步验证" }, parent.left);
      continue;
    }

    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === state.node)) {
      const context = state.returns.at(-1);
      const owner = ts.isArrowFunction(parent) ? parent : findEnclosingCallable(parent);
      if (context && owner === context.owner) {
        const body = context.owner.body;
        const onlyReturn = body && (ts.isBlock(body)
          ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
            && body.statements[0]!.expression === state.node
          : body === state.node);
        enqueue(state, context.call, {
          returns: state.returns.slice(0, -1),
          possible: state.possible || !onlyReturn,
          reason: state.reason ?? (onlyReturn ? null : "函数存在其他返回路径，返回值与目标函数的同一性未能证明")
        });
      } else {
        retainUnknown(state, "函数值被返回，尚未解析返回值的接收者");
      }
      continue;
    }

    if (
      ts.isExportAssignment(parent)
      && !parent.isExportEquals
      && containsNode(parent.expression, state.node)
    ) {
      for (const use of findDefaultImportReferences(
        parent.getSourceFile(),
        checker,
        projectSources
      )) {
        enqueue(state, use, { path: [] });
      }
      continue;
    }
    if (isReferenceNode(state.node)) {
      const kind = classifyNonCallReference(state.node);
      if (kind === "import" || kind === "export") continue;
    }
    if (ts.isExpressionStatement(parent)) continue;
    retainUnknown(state, state.reason ?? "此处函数值的后续流向尚不受静态追踪支持");
  }
  if (queue.length > 0) {
    const location = locationOf(reference, projectPath);
    traversalLimits.add(`间接引用追踪达到最大状态数 ${maxStates}：${location.file}:${location.line}`);
  }
  return { calls: results, unresolved };
}

function isSourceCallable(node: ts.Node): node is SourceCallable {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
}

function isConstBinding(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function hasDynamicParameterAccess(owner: SourceCallable): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && (node.text === "arguments" || node.text === "eval")) found = true;
    ts.forEachChild(node, visit);
  };
  if (owner.body) visit(owner.body);
  return found;
}

function unwrapValue(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

function isBindingWrite(node: ts.Node): boolean {
  // Destructuring writes still change the binding, unlike a write to one of
  // the function object's own properties.
  while (ts.isParenthesizedExpression(node.parent) || ts.isArrayLiteralExpression(node.parent)
    || ts.isObjectLiteralExpression(node.parent) || ts.isShorthandPropertyAssignment(node.parent)
    || ts.isPropertyAssignment(node.parent) || ts.isSpreadElement(node.parent)
    || ts.isSpreadAssignment(node.parent)) node = node.parent;
  const parent = node.parent;
  return (ts.isBinaryExpression(parent) && parent.left === node
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
}

function findDefaultImportReferences(
  exportedSource: ts.SourceFile,
  checker: ts.TypeChecker,
  projectSources: ts.SourceFile[]
): Array<ts.Identifier | ts.PropertyAccessExpression> {
  const references: Array<ts.Identifier | ts.PropertyAccessExpression> = [];
  for (const source of projectSources) {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause?.name) {
        const localName = node.importClause.name;
        const localSymbol = checker.getSymbolAtLocation(localName);
        const resolved = localSymbol ? resolveAlias(localSymbol, checker) : undefined;
        const importsExportedSource = resolved?.declarations?.some((declaration) => (
          path.resolve(declaration.getSourceFile().fileName) === path.resolve(exportedSource.fileName)
        ));
        if (localSymbol && importsExportedSource) {
          for (const use of findSymbolReferences(localSymbol, checker, projectSources)) {
            if (use !== localName) references.push(use);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return references;
}

function liftThroughContainer(parent: ts.Node, state: LiftState): Omit<LiftState, "depth"> | null {
  if (ts.isPropertyAssignment(parent) && containsNode(parent.initializer, state.node)) {
    return {
      ...state,
      node: parent,
      path: [propertyNameText(parent.name), ...state.path]
    };
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === state.node) {
    return {
      ...state,
      node: parent,
      path: [parent.name.getText(), ...state.path]
    };
  }
  if (ts.isSpreadAssignment(parent) && containsNode(parent.expression, state.node)) {
    return { ...state, node: parent, path: ["...spread", ...state.path] };
  }
  if (ts.isObjectLiteralExpression(parent) && parent.properties.includes(state.node as ts.ObjectLiteralElementLike)) {
    return { ...state, node: parent, payloadNode: parent };
  }
  if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(state.node as ts.Expression)) {
    const index = parent.elements.indexOf(state.node as ts.Expression);
    return { ...state, node: parent, payloadNode: parent, path: [`[${index}]`, ...state.path] };
  }
  if (
    ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)
    || ts.isSatisfiesExpression(parent)
    || ts.isAwaitExpression(parent)
  ) {
    return { ...state, node: parent };
  }
  if (ts.isConditionalExpression(parent) && (
    containsNode(parent.whenTrue, state.node) || containsNode(parent.whenFalse, state.node)
  )) {
    return { ...state, node: parent, payloadNode: parent, possible: true,
      reason: "条件表达式存在其他函数值，执行目标未能唯一确认" };
  }
  return null;
}

function findSymbolReferences(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  projectSources: ts.SourceFile[]
): Array<ts.Identifier | ts.PropertyAccessExpression> {
  const resolved = resolveAlias(symbol, checker);
  const declarations = new Set(resolved.getDeclarations() ?? symbol.getDeclarations() ?? []);
  const references: Array<ts.Identifier | ts.PropertyAccessExpression> = [];
  for (const source of projectSources) {
    const visit = (node: ts.Node): void => {
      if (
        isReferenceNode(node)
        && !(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && symbolMatches(node, resolved, declarations, checker)
        && !isDefinitionName(node, declarations)
      ) references.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return references;
}

function buildIndirectCallSite(
  carrier: ts.CallExpression | ts.NewExpression,
  payload: ts.Expression,
  pathParts: string[],
  checker: ts.TypeChecker,
  projectPath: string
): CallSite {
  const argumentsList = genericCallArguments(carrier, checker);
  if (ts.isObjectLiteralExpression(payload)) {
    for (const property of payload.properties) {
      if (ts.isSpreadAssignment(property)) {
        argumentsList.push(callArgument(
          "payload...spread",
          property.expression,
          checker
        ));
        continue;
      }
      const expression = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      if (expression) {
        argumentsList.push(callArgument(
          `payload.${propertyNameText(property.name)}`,
          expression,
          checker
        ));
      }
    }
  }
  return {
    kind: "indirect",
    location: locationOf(carrier, projectPath),
    enclosing_callable: callableName(findEnclosingCallable(carrier)),
    arguments: argumentsList,
    provided_parameters: argumentsList.map((item) => item.parameter),
    omitted_parameters: [],
    preconditions: collectPreconditions(carrier),
    invocation: carrier.getText().slice(0, 1_000),
    target_path: pathParts.length > 0 ? pathParts.join(".") : "<argument>",
    payload_expression: payload.getText().slice(0, 1_000),
    target_usage: {
      kind: "value-transfer",
      certainty: "confirmed",
      evidence_refs: [evidenceRef(carrier, projectPath)],
      unresolved_reason: "只确认函数值已传入，接收者如何使用或执行该值尚未证明"
    }
  };
}

function genericCallArguments(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker
): CallArgument[] {
  const signature = checker.getResolvedSignature(node);
  const parameters = signature?.getParameters() ?? [];
  return [...(node.arguments ?? [])].map((argument, index) => callArgument(
    parameters[index]?.getName() ?? `arg${index + 1}`,
    argument,
    checker
  ));
}

function callArgument(
  parameter: string,
  expression: ts.Expression,
  checker: ts.TypeChecker
): CallArgument {
  return {
    parameter,
    expression: expression.getText().slice(0, 500),
    inferred_type: checker.typeToString(
      checker.getTypeAtLocation(expression),
      expression,
      ts.TypeFormatFlags.NoTruncation
    ),
    provided: true
  };
}

function propertyNameText(name: ts.PropertyName | undefined): string {
  if (!name) return "<unknown>";
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

function collectOutgoingCalls(
  declarations: readonly ts.Declaration[],
  checker: ts.TypeChecker,
  projectPath: string
): OutgoingCall[] {
  const calls: OutgoingCall[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const location = locationOf(node, projectPath);
        const key = `${location.file}:${location.line}:${location.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({
            kind: ts.isNewExpression(node) ? "new" : "call",
            location,
            enclosing_callable: callableName(findEnclosingCallable(node)),
            callee: node.expression.getText().slice(0, 500),
            invocation: node.getText().slice(0, 1_000),
            arguments: genericCallArguments(node, checker),
            preconditions: collectPreconditions(node)
          });
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const location = locationOf(node, projectPath);
        const key = `${location.file}:${location.line}:${location.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          const jsxCall = buildJsxCallSite(node, [], checker, projectPath);
          calls.push({
            kind: "jsx",
            location,
            enclosing_callable: jsxCall.enclosing_callable,
            callee: node.tagName.getText().slice(0, 500),
            invocation: jsxCall.invocation,
            arguments: jsxCall.arguments,
            preconditions: jsxCall.preconditions
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  return calls;
}

function findEnclosingCallableAtLocation(
  sources: ts.SourceFile[],
  location: SourceLocation,
  projectPath: string
): ts.Node | undefined {
  const source = sources.find((item) => relative(projectPath, item.fileName) === location.file);
  if (!source) return undefined;
  const position = source.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.end) return;
    const callable = findEnclosingCallable(node);
    if (callable) found = callable;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function buildPublicWrapper(
  node: ts.Node,
  calls: CallSite[],
  checker: ts.TypeChecker,
  projectPath: string
): PublicWrapper {
  const signature = checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
  return {
    name: callableName(node) ?? "<anonymous>",
    location: locationOf(node, projectPath),
    parameters: signature
      ? signature.getParameters().map((parameter) => parameterContract(parameter, checker, node))
      : [],
    target_calls: calls.map((call) => ({
      location: call.location,
      argument_mapping: call.arguments,
      preconditions: call.preconditions,
      target_usage: call.target_usage
    }))
  };
}

function groupCombinations(callSites: CallSite[]): NonNullable<SymbolContractAnalysis["calls"]>["combinations"] {
  const groups = new Map<string, NonNullable<SymbolContractAnalysis["calls"]>["combinations"][number]>();
  for (const call of callSites) {
    const provided = [...call.provided_parameters].sort();
    const key = `${call.kind}:${call.target_usage.kind}:${call.target_usage.certainty}:${provided.join("|")}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.locations.push(call.location);
    } else {
      groups.set(key, {
        kind: call.kind,
        target_usage: { kind: call.target_usage.kind, certainty: call.target_usage.certainty },
        provided_parameters: provided,
        count: 1,
        locations: [call.location]
      });
    }
  }
  return [...groups.values()].sort((a, b) => (
    a.kind.localeCompare(b.kind) || a.provided_parameters.join("|").localeCompare(b.provided_parameters.join("|"))
  ));
}

function buildPage(
  offset: number,
  limit: number,
  returned: number,
  total: number
): { offset: number; limit: number; returned: number; total: number; next_offset: number | null } {
  return {
    offset,
    limit,
    returned,
    total,
    next_offset: offset + returned < total ? offset + returned : null
  };
}

function collectPreconditions(node: ts.Node): string[] {
  const conditions: string[] = [];
  let child = node;
  for (let current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      conditions.push(current.thenStatement === child || containsNode(current.thenStatement, child)
        ? current.expression.getText()
        : `NOT (${current.expression.getText()})`);
    } else if (ts.isConditionalExpression(current)) {
      conditions.push(current.whenTrue === child || containsNode(current.whenTrue, child)
        ? current.condition.getText()
        : `NOT (${current.condition.getText()})`);
    } else if (ts.isBinaryExpression(current) && containsNode(current.right, child)) {
      if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        conditions.push(current.left.getText());
      } else if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        conditions.push(`NOT (${current.left.getText()})`);
      }
    } else if (ts.isWhileStatement(current) || ts.isDoStatement(current)) {
      conditions.push(current.expression.getText());
    } else if (ts.isForStatement(current) && current.condition) {
      conditions.push(current.condition.getText());
    } else if (ts.isCaseClause(current)) {
      conditions.push(`switch case ${current.expression.getText()}`);
    }
  }

  const statement = findContainingStatement(node);
  const block = statement?.parent;
  if (statement && block && ts.isBlock(block)) {
    const index = block.statements.indexOf(statement);
    for (const previous of block.statements.slice(0, Math.max(0, index))) {
      if (ts.isIfStatement(previous) && !previous.elseStatement && alwaysTerminates(previous.thenStatement)) {
        conditions.push(`after guard: NOT (${previous.expression.getText()})`);
      }
    }
  }
  return [...new Set(conditions)];
}

function alwaysTerminates(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isContinueStatement(node) || ts.isBreakStatement(node)) {
    return true;
  }
  return ts.isBlock(node) && node.statements.length > 0 && alwaysTerminates(node.statements[node.statements.length - 1]);
}

function isPublicCallable(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isVariableDeclarationList(node.parent.parent)
    && ts.isVariableStatement(node.parent.parent.parent)
  ) {
    return hasModifier(node.parent.parent.parent, ts.SyntaxKind.ExportKeyword);
  }
  if (ts.isMethodDeclaration(node)) {
    if (hasModifier(node, ts.SyntaxKind.PrivateKeyword) || hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return false;
    const owner = node.parent;
    return ts.isClassDeclaration(owner) && hasModifier(owner, ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

function findEnclosingCallable(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
      || ts.isConstructorDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isCallableNode(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function callableName(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if ("name" in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent))
  ) {
    return node.parent.name.getText();
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isBinaryExpression(node.parent)
    && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return node.parent.left.getText();
  }
  return ts.isConstructorDeclaration(node) ? "constructor" : "<anonymous>";
}

function symbolMatches(
  node: ts.Node,
  target: ts.Symbol,
  targetDeclarations: Set<ts.Declaration>,
  checker: ts.TypeChecker
): boolean {
  const found = valueSymbol(node, checker);
  if (!found) return false;
  const resolved = resolveAlias(found, checker);
  if (resolved === target) return true;
  return Boolean(resolved.declarations?.some((declaration) => targetDeclarations.has(declaration)));
}

function valueSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const lookup = ts.isPropertyAccessExpression(node) ? node.name : node;
  return ts.isIdentifier(lookup) && ts.isShorthandPropertyAssignment(lookup.parent)
    ? checker.getShorthandAssignmentValueSymbol(lookup.parent) ?? checker.getSymbolAtLocation(lookup)
    : checker.getSymbolAtLocation(lookup);
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isReferenceNode(node: ts.Node): node is ts.Identifier | ts.PropertyAccessExpression {
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node);
}

function isDefinitionName(node: ts.Node, declarations: Set<ts.Declaration>): boolean {
  return [...declarations].some((declaration) => (
    declarationNameNode(declaration) === node || declaration === node
  ));
}

function isDirectInvocationReference(node: ts.Node): boolean {
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const grandparent = parent.parent;
    return (ts.isCallExpression(grandparent) || ts.isNewExpression(grandparent)) && grandparent.expression === parent;
  }
  if (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))
    && parent.tagName === node
  ) return true;
  return false;
}

function classifyNonCallReference(node: ts.Node): string {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return "import";
  if (ts.isExportSpecifier(parent)) return "export";
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) return "passed-as-argument";
  if (ts.isReturnStatement(parent)) return "returned";
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return "assigned";
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return "stored-as-property";
  return "non-call-reference";
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node)
    || ts.isVariableDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) {
    return node.name;
  }
  return undefined;
}

function describeDeclarationKind(declaration: ts.Declaration): string {
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isMethodDeclaration(declaration)) return "method";
  if (ts.isClassDeclaration(declaration)) return "class/component";
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer && ts.isArrowFunction(declaration.initializer)) return "arrow-function/component";
    if (declaration.initializer && ts.isFunctionExpression(declaration.initializer)) return "function-expression/component";
    return "variable";
  }
  return ts.SyntaxKind[declaration.kind] ?? "declaration";
}

function looksLikeComponent(
  declaration: ts.Declaration,
  signatures: readonly ts.Signature[],
  checker: ts.TypeChecker
): boolean {
  const name = declarationNameNode(declaration)?.getText() ?? "";
  if (!/^[A-Z]/.test(name)) return false;
  return signatures.some((signature) => {
    const returnType = checker.typeToString(signature.getReturnType(), declaration);
    return /JSX|React|Element/.test(returnType);
  }) || containsJsx(declaration);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function shouldExpandProperties(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const text = type.symbol?.getName();
  return text !== "Array" && text !== "Function" && text !== "Promise";
}

function collectBindingDefaults(declaration: ts.Declaration | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!declaration || !ts.isParameter(declaration) || !ts.isObjectBindingPattern(declaration.name)) return result;
  for (const element of declaration.name.elements) {
    if (element.initializer) result.set(element.name.getText(), element.initializer.getText());
  }
  return result;
}

function documentationOf(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | null {
  if (!symbol) return null;
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  return text || null;
}

function symbolOfDeclaration(
  declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  if (!declaration) return undefined;
  if ("name" in declaration && declaration.name) {
    return checker.getSymbolAtLocation(declaration.name as ts.Node);
  }
  return undefined;
}

function initializerText(declaration: ts.Declaration | undefined): string | null {
  if (
    declaration
    && (
      ts.isParameter(declaration)
      || ts.isPropertyDeclaration(declaration)
      || ts.isVariableDeclaration(declaration)
      || ts.isBindingElement(declaration)
    )
    && declaration.initializer
  ) {
    return declaration.initializer.getText().slice(0, 500);
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function findContainingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isStatement(current)) current = current.parent;
  return current as ts.Statement | undefined;
}

function containsNode(parent: ts.Node, child: ts.Node): boolean {
  return child.pos >= parent.pos && child.end <= parent.end;
}

function locationOf(node: ts.Node, projectPath: string): SourceLocation {
  const file = node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    file: relative(projectPath, file.fileName),
    line: start.line + 1,
    column: start.character + 1
  };
}

function declarationContainsLine(declaration: ts.Declaration, targetLine: number): boolean {
  const file = declaration.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1;
  const end = file.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1;
  return targetLine >= start && targetLine <= end;
}

function compareLocations(a: { location: SourceLocation }, b: { location: SourceLocation }): number {
  return compareSourceLocations(a.location, b.location);
}

function compareSourceLocations(a: SourceLocation, b: SourceLocation): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

function relative(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).split(path.sep).join("/");
}

function isInsideProject(projectPath: string, targetPath: string): boolean {
  const rel = path.relative(projectPath, path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInsideProject(projectPath: string, targetPath: string): void {
  if (!isInsideProject(projectPath, targetPath)) {
    throw new Error(`目标文件必须位于项目目录内：${targetPath}`);
  }
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
