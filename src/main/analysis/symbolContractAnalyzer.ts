import path from "node:path";
import ts from "typescript";

export type SymbolAnalysisSection = "all" | "contract" | "calls" | "wrappers" | "references";

export interface AnalyzeSymbolContractInput {
  projectPath: string;
  targetFile: string;
  symbol: string;
  targetLine?: number;
  section?: SymbolAnalysisSection;
  offset?: number;
  limit?: number;
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
  kind: "call" | "jsx";
  location: SourceLocation;
  enclosing_callable: string | null;
  arguments: CallArgument[];
  provided_parameters: string[];
  omitted_parameters: string[];
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
    files_scanned: number;
    total_call_sites: number;
    total_public_wrappers: number;
    total_non_call_references: number;
    static_analysis_limits: string[];
  };
  contract?: {
    inputs: ParameterContract[];
    outputs: Array<{ type: string; meaning: string | null }>;
    component_props: ParameterContract[];
  };
  calls?: {
    items: CallSite[];
    combinations: Array<{
      kind: "call" | "jsx";
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
}

export function analyzeSymbolContract(input: AnalyzeSymbolContractInput): SymbolContractAnalysis {
  const projectPath = path.resolve(input.projectPath);
  const targetFile = path.isAbsolute(input.targetFile)
    ? path.resolve(input.targetFile)
    : path.resolve(projectPath, input.targetFile);
  assertInsideProject(projectPath, targetFile);

  const program = createProgram(projectPath, targetFile);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(targetFile);
  if (!sourceFile) {
    throw new Error(`目标文件未被 TypeScript 程序加载：${relative(projectPath, targetFile)}`);
  }

  const target = resolveTargetSymbol(sourceFile, input.symbol, checker, input.targetLine);
  const targetDeclarations = target.symbol.getDeclarations() ?? [target.declaration];
  const targetDeclarationSet = new Set(targetDeclarations);
  const signatures = checker.getTypeOfSymbolAtLocation(target.symbol, target.declaration).getCallSignatures();
  const contract = buildContract(signatures, target.declaration, checker);

  const callSites: CallSite[] = [];
  const wrapperCalls = new Map<ts.Node, CallSite[]>();
  const nonCallReferences: NonCallReference[] = [];
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
          nonCallReferences.push({
            location: locationOf(node, projectPath),
            kind: classifyNonCallReference(node),
            expression: node.getText().slice(0, 300)
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  callSites.sort(compareLocations);
  nonCallReferences.sort(compareLocations);
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
      files_scanned: projectSources.length,
      total_call_sites: callSites.length,
      total_public_wrappers: wrappers.length,
      total_non_call_references: nonCallReferences.length,
      static_analysis_limits: [
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
  return result;
}

function createProgram(projectPath: string, targetFile: string): ts.Program {
  const configPath = ts.findConfigFile(projectPath, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(formatDiagnostic(config.error));
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), {
      noEmit: true,
      allowJs: true
    }, configPath);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
    }
    const allProjectFiles = ts.sys.readDirectory(
      projectPath,
      [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
      ["**/node_modules/**", "**/dist/**", "**/build/**", "**/release/**", "**/.git/**"]
    );
    const rootNames = [...new Set([...parsed.fileNames, ...allProjectFiles, targetFile])];
    return ts.createProgram({ rootNames, options: parsed.options });
  }

  const rootNames = ts.sys.readDirectory(
    projectPath,
    [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    ["node_modules", "dist", "build", "release", ".git"]
  );
  if (!rootNames.includes(targetFile)) rootNames.push(targetFile);
  return ts.createProgram({
    rootNames,
    options: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022
    }
  });
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
  const componentProps = looksLikeComponent(declaration, signatures, checker) && inputs.length === 1
    ? (inputs[0].properties ?? [])
    : [];
  return { inputs, outputs, component_props: componentProps };
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
    preconditions: collectPreconditions(node)
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
    preconditions: collectPreconditions(node)
  };
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

function callableName(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if ("name" in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
  ) {
    return node.parent.name.getText();
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
