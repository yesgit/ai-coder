import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface BoundedTypeScriptProgram {
  program: ts.Program;
  mode: "project-config" | "syntax-fallback";
  warnings: string[];
}

const PROGRAM_CACHE_LIMIT = 8;
const programCache = new Map<string, BoundedTypeScriptProgram>();

/**
 * Build a TypeScript program whose project-local module resolution is limited
 * to the supplied evidence-bearing files.
 *
 * The normal TypeScript project loader eagerly follows every import and every
 * configured root. In large legacy React Native repositories that can pull in
 * thousands of declarations even when an investigation targets one file. The
 * analysis tools only need the files that passed their lexical evidence pass,
 * so restricting local resolution preserves symbol links between those files
 * without loading the rest of the application or node_modules.
 */
export function createBoundedTypeScriptProgram(
  projectPathInput: string,
  rootFilesInput: string[]
): BoundedTypeScriptProgram {
  const projectPath = path.resolve(projectPathInput);
  const rootFiles = [...new Set(rootFilesInput.map((file) => path.resolve(file)))]
    .filter((file) => isInsideProject(projectPath, file) && existsSync(file))
    .sort();
  if (rootFiles.length === 0) {
    throw new Error("受限 TypeScript 分析没有可加载的源码文件");
  }

  const configPath = ts.findConfigFile(projectPath, ts.sys.fileExists, "tsconfig.json");
  const configText = configPath && existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const cacheKey = programCacheKey(projectPath, rootFiles, configPath, configText);
  const cached = programCache.get(cacheKey);
  if (cached) {
    programCache.delete(cacheKey);
    programCache.set(cacheKey, cached);
    return cached;
  }

  const warnings: string[] = [];
  let mode: BoundedTypeScriptProgram["mode"] = "syntax-fallback";
  let configuredOptions: ts.CompilerOptions = {};
  if (configPath && configText) {
    const parsedConfig = ts.parseConfigFileTextToJson(configPath, configText);
    if (parsedConfig.error) {
      warnings.push(formatDiagnostic(parsedConfig.error));
    } else {
      const converted = ts.convertCompilerOptionsFromJson(
        parsedConfig.config?.compilerOptions ?? {},
        path.dirname(configPath),
        configPath
      );
      if (converted.errors.length > 0) {
        warnings.push(...converted.errors.map(formatDiagnostic));
      } else {
        configuredOptions = converted.options;
        mode = "project-config";
      }
    }
  }

  const options: ts.CompilerOptions = {
    ...configuredOptions,
    allowJs: true,
    checkJs: false,
    jsx: configuredOptions.jsx ?? ts.JsxEmit.ReactJSX,
    module: configuredOptions.module ?? ts.ModuleKind.NodeNext,
    moduleResolution: configuredOptions.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    // Loading ambient packages is the largest source of memory growth in the
    // old census and is unnecessary for locating project-owned symbols.
    types: []
  };
  const allowedFiles = new Set(rootFiles.map(normalizePath));
  const host = ts.createCompilerHost(options);
  const resolutionCache = ts.createModuleResolutionCache(
    projectPath,
    (file) => normalizePath(file),
    options
  );
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    const resolved = ts.resolveModuleName(
      moduleName,
      containingFile,
      options,
      ts.sys,
      resolutionCache
    ).resolvedModule;
    if (!resolved) return undefined;
    return allowedFiles.has(normalizePath(resolved.resolvedFileName))
      ? resolved
      : undefined;
  });

  const result: BoundedTypeScriptProgram = {
    program: ts.createProgram({ rootNames: rootFiles, options, host }),
    mode,
    warnings
  };
  programCache.set(cacheKey, result);
  while (programCache.size > PROGRAM_CACHE_LIMIT) {
    const oldest = programCache.keys().next().value;
    if (typeof oldest !== "string") break;
    programCache.delete(oldest);
  }
  return result;
}

function programCacheKey(
  projectPath: string,
  rootFiles: string[],
  configPath: string | undefined,
  configText: string
): string {
  const fingerprint = rootFiles.map((file) => {
    const stat = statSync(file);
    return `${normalizePath(file)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  });
  return createHash("sha256")
    .update(JSON.stringify({
      projectPath: normalizePath(projectPath),
      configPath: configPath ? normalizePath(configPath) : null,
      configText,
      fingerprint
    }))
    .digest("hex");
}

function normalizePath(file: string): string {
  return path.resolve(file).split(path.sep).join("/");
}

function isInsideProject(projectPath: string, target: string): boolean {
  const relative = path.relative(projectPath, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
