import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createBoundedTypeScriptProgram } from "./boundedTypeScriptProgram.js";

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
  }>;
}

interface NonCallReference {
  location: SourceLocation;
  kind: string;
  expression: string;
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
    total_call_sites: number;
    total_public_wrappers: number;
    total_non_call_references: number;
    total_outgoing_calls: number;
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
  const indirectCallKeys = new Set<string>();
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
            ? []
            : liftReferenceToIndirectCalls(node, checker, projectSources, projectPath);
          if (lifted.length > 0) {
            for (const callSite of lifted) {
              const key = [
                callSite.location.file,
                callSite.location.line,
                callSite.location.column,
                callSite.target_path,
                callSite.payload_expression
              ].join("\0");
              if (indirectCallKeys.has(key)) continue;
              indirectCallKeys.add(key);
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
          } else {
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
      total_call_sites: callSites.length,
      total_public_wrappers: wrappers.length,
      total_non_call_references: nonCallReferences.length,
      total_outgoing_calls: outgoingCalls.length,
      static_analysis_limits: programBuild.mode === "syntax-fallback"
        ? [
            "未加载有效 TypeScript 项目配置，符号解析采用语法回退。",
            ...programBuild.warnings
          ]
        : [],
      analysis_notes: [
        "反射、字符串注册、运行时依赖注入和外部包调用无法由静态分析证明完整。",
        "回调或函数值传递列在 references 中；其最终运行时调用方需要继续追踪。",
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
} {
  const sourceFiles = discoverProjectSources(projectPath);
  const evidenceFiles = sourceFiles.filter((file) => {
    if (path.resolve(file) === path.resolve(targetFile)) return true;
    if (symbol.length <= 3 || /^(?:fun|callback|sucFun|errFun|render)$/i.test(symbol)) {
      return false;
    }
    try {
      return readFileSync(file, "utf8").includes(symbol);
    } catch {
      return false;
    }
  });
  if (!evidenceFiles.includes(targetFile)) evidenceFiles.push(targetFile);
  expandEvidenceFilesForAliases(sourceFiles, evidenceFiles, symbol);
  return createBoundedTypeScriptProgram(projectPath, evidenceFiles);
}

function expandEvidenceFilesForAliases(
  sourceFiles: string[],
  evidenceFiles: string[],
  initialSymbol: string
): void {
  const included = new Set(evidenceFiles.map((file) => path.resolve(file)));
  let frontier = new Set([initialSymbol]);
  const seenSymbols = new Set(frontier);
  const maxRounds = 4;
  const maxFiles = 500;

  for (let round = 0; round < maxRounds && frontier.size > 0 && included.size < maxFiles; round += 1) {
    const aliases = new Set<string>();
    for (const file of [...included]) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (![...frontier].some((name) => containsIdentifierText(content, name))) continue;
      const source = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForFile(file)
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.initializer
          && [...frontier].some((name) => containsIdentifierText(node.initializer!.getText(source), name))
          && isExportedVariableDeclaration(node)
        ) {
          const alias = node.name.text;
          if (alias.length >= 4 && !seenSymbols.has(alias)) aliases.add(alias);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (aliases.size === 0) break;
    for (const alias of aliases) seenSymbols.add(alias);
    for (const file of sourceFiles) {
      if (included.has(path.resolve(file))) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (![...aliases].some((alias) => containsIdentifierText(content, alias))) continue;
      included.add(path.resolve(file));
      evidenceFiles.push(file);
      if (included.size >= maxFiles) break;
    }
    frontier = aliases;
  }
}

function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement)
    && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function containsIdentifierText(content: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![$\\w])${escaped}(?![$\\w])`, "u").test(content);
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
  const signature = resolved ?? targetSignatures[0];
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
    payload_expression: null
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
    payload_expression: null
  };
}

interface LiftState {
  node: ts.Node;
  payloadNode: ts.Expression;
  path: string[];
  depth: number;
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
  checker: ts.TypeChecker,
  projectSources: ts.SourceFile[],
  projectPath: string
): CallSite[] {
  const queue: LiftState[] = [{
    node: reference,
    payloadNode: reference,
    path: [],
    depth: 0
  }];
  const seen = new Set<string>();
  const results: CallSite[] = [];
  const maxDepth = 12;
  const maxStates = 100;

  while (queue.length > 0 && seen.size < maxStates) {
    const state = queue.shift()!;
    if (state.depth > maxDepth) continue;
    const stateKey = [
      state.node.getSourceFile().fileName,
      state.node.pos,
      state.node.end,
      state.path.join(".")
    ].join(":");
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);
    const parent = state.node.parent;
    if (!parent) continue;

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && Boolean(parent.arguments?.includes(state.node as ts.Expression))
    ) {
      results.push(buildIndirectCallSite(
        parent,
        state.payloadNode,
        state.path,
        checker,
        projectPath
      ));
      // A value passed to a HOC/factory is often returned as another component
      // and immediately assigned or exported (React.memo/connect/forwardRef are
      // common examples). Keep following that result as a possible carrier.
      // A registration call used only as a statement naturally terminates on
      // the next iteration, so this remains API agnostic and bounded.
      queue.push({
        ...state,
        node: parent,
        depth: state.depth + 1
      });
      continue;
    }

    const lifted = liftThroughContainer(parent, state);
    if (lifted) {
      queue.push({ ...lifted, depth: state.depth + 1 });
      continue;
    }

    if (
      ts.isVariableDeclaration(parent)
      && parent.initializer
      && containsNode(parent.initializer, state.node)
      && ts.isIdentifier(parent.name)
    ) {
      const alias = checker.getSymbolAtLocation(parent.name);
      if (!alias) continue;
      for (const use of findSymbolReferences(alias, checker, projectSources)) {
        if (use === parent.name) continue;
        queue.push({
          ...state,
          node: use,
          depth: state.depth + 1
        });
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
        queue.push({
          ...state,
          node: use,
          path: [],
          depth: state.depth + 1
        });
      }
    }
  }
  return results;
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
    return { ...state, node: parent, payloadNode: parent };
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
    payload_expression: payload.getText().slice(0, 1_000)
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
      preconditions: call.preconditions
    }))
  };
}

function groupCombinations(callSites: CallSite[]): NonNullable<SymbolContractAnalysis["calls"]>["combinations"] {
  const groups = new Map<string, NonNullable<SymbolContractAnalysis["calls"]>["combinations"][number]>();
  for (const call of callSites) {
    const provided = [...call.provided_parameters].sort();
    const key = `${call.kind}:${provided.join("|")}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.locations.push(call.location);
    } else {
      groups.set(key, {
        kind: call.kind,
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
  const lookup = ts.isPropertyAccessExpression(node) ? node.name : node;
  const found = checker.getSymbolAtLocation(lookup);
  if (!found) return false;
  const resolved = resolveAlias(found, checker);
  if (resolved === target) return true;
  return Boolean(resolved.declarations?.some((declaration) => targetDeclarations.has(declaration)));
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
