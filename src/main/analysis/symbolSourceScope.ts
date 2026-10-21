import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface SymbolSourceScope {
  files: string[];
  coverage: {
    kind: "project-local-module-graph";
    files_discovered: number;
    files_required: number;
    files_selected: number;
    complete: boolean;
    limitations: string[];
  };
}

/**
 * Select source by module identity, independently of the target's spelling.
 * First find every transitive importer of the target, then include the local
 * dependencies needed to bind those sources. Do not follow reverse edges from
 * those dependencies: sharing a utility does not make two modules callers.
 */
export function collectSymbolSourceScope(
  projectPath: string,
  sourceFiles: string[],
  targetFile: string,
  symbol: string,
  options: ts.CompilerOptions,
  maxFiles = 500
): SymbolSourceScope {
  const files = [...new Set([...sourceFiles, targetFile].map((file) => path.resolve(file)))].sort();
  const knownFiles = new Set(files);
  const dependencies = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const seeds = new Set([path.resolve(targetFile)]);
  const lexicalMatches = new Set<string>();
  let targetIsModule = true;
  const limitations = new Set<string>();
  const resolutionCache = ts.createModuleResolutionCache(projectPath, (file) => file, options);

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      limitations.add(`源码无法读取，调用范围未闭合：${path.relative(projectPath, file)}`);
      continue;
    }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false);
    const imports = ts.preProcessFile(content, true, true);
    const isModule = ts.isExternalModule(source);
    if (file === path.resolve(targetFile)) targetIsModule = isModule;
    if (content.includes(symbol)) lexicalMatches.add(file);
    // Global scripts can refer to declarations without a module edge. Module
    // callers, including short/common names, are selected by import identity.
    if (!isModule && lexicalMatches.has(file)) seeds.add(file);
    const localDependencies = new Set<string>();
    dependencies.set(file, localDependencies);
    for (const item of imports.importedFiles) {
      const resolved = ts.resolveModuleName(item.fileName, file, options, ts.sys, resolutionCache).resolvedModule;
      const dependency = resolved && path.resolve(resolved.resolvedFileName);
      if (dependency && knownFiles.has(dependency)) {
        localDependencies.add(dependency);
        const users = importers.get(dependency) ?? new Set<string>();
        users.add(file);
        importers.set(dependency, users);
      } else if (!resolved && isProjectModule(item.fileName, options)) {
        // An unresolved local edge anywhere in the index might hide an import
        // path to the target. Keep this uncertainty even if the file is outside
        // the currently selected component of the graph.
        limitations.add(`本地模块未解析，调用范围未闭合：${path.relative(projectPath, file)} → ${item.fileName}`);
      }
    }
    for (const item of imports.referencedFiles) {
      const dependency = path.resolve(path.dirname(file), item.fileName);
      if (!knownFiles.has(dependency)) continue;
      localDependencies.add(dependency);
      const users = importers.get(dependency) ?? new Set<string>();
      users.add(file);
      importers.set(dependency, users);
    }
  }

  // Global declarations are visible in modules as well as other scripts.
  if (!targetIsModule) {
    for (const file of lexicalMatches) seeds.add(file);
  }

  const selected = new Set<string>();
  const includeClosure = (roots: Iterable<string>, edges: Map<string, Set<string>>): void => {
    const queue = [...roots];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const file = queue[index]!;
      if (visited.has(file)) continue;
      visited.add(file);
      selected.add(file);
      queue.push(...(edges.get(file) ?? []));
    }
  };
  includeClosure(seeds, importers);
  includeClosure(selected, dependencies);
  const selectedFiles = [...selected].slice(0, maxFiles).sort();
  if (selectedFiles.length < selected.size) {
    limitations.add(`模块分析达到最大文件数 ${maxFiles}：需要 ${selected.size} 个文件，`
      + `${selected.size - selectedFiles.length} 个文件未加载，调用范围未闭合`);
  }
  return {
    files: selectedFiles,
    coverage: {
      kind: "project-local-module-graph",
      files_discovered: files.length,
      files_required: selected.size,
      files_selected: selectedFiles.length,
      complete: limitations.size === 0,
      limitations: [...limitations].sort()
    }
  };
}

function isProjectModule(specifier: string, options: ts.CompilerOptions): boolean {
  if (specifier.startsWith(".")) return true;
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return star < 0
      ? specifier === pattern
      : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}
