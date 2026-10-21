import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
 * analysis tools only need the files selected by their evidence scope,
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

  const { options, mode, warnings, configPath, configText } = readTypeScriptProjectConfiguration(projectPath);
  const cacheKey = programCacheKey(projectPath, rootFiles, configPath, configText);
  const cached = programCache.get(cacheKey);
  if (cached) {
    programCache.delete(cacheKey);
    programCache.set(cacheKey, cached);
    return cached;
  }

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

/** Read the same resolution options for indexing and binding without building
 * an extra Program. Inherited paths/baseUrl must resolve identically in both.
 */
export function readTypeScriptProjectConfiguration(projectPath: string): {
  options: ts.CompilerOptions;
  mode: BoundedTypeScriptProgram["mode"];
  warnings: string[];
  configPath: string | undefined;
  configText: string;
} {
  const configPath = ts.findConfigFile(projectPath, ts.sys.fileExists, "tsconfig.json");
  const configTexts: string[] = [];
  const warnings: string[] = [];
  let mode: BoundedTypeScriptProgram["mode"] = "syntax-fallback";
  let configuredOptions: ts.CompilerOptions = {};
  if (configPath) {
    const readConfig = (file: string): string | undefined => {
      const text = ts.sys.readFile(file);
      if (text !== undefined) configTexts.push(`${file}\n${text}`);
      return text;
    };
    const config = ts.readConfigFile(configPath, readConfig);
    if (config.error) {
      warnings.push(formatDiagnostic(config.error));
    } else {
      const parsed = ts.parseJsonConfigFileContent(config.config, {
        ...ts.sys,
        readFile: readConfig,
        // Root files come from the evidence scope; parsing configuration must
        // not enumerate or eagerly load the project's configured roots.
        readDirectory: () => []
      }, path.dirname(configPath), undefined, configPath);
      const errors = parsed.errors.filter((error) => error.code !== 18003);
      if (errors.length > 0) {
        warnings.push(...errors.map(formatDiagnostic));
      } else {
        configuredOptions = parsed.options;
        mode = "project-config";
      }
    }
  }
  return {
    options: {
      ...configuredOptions,
      allowJs: true,
      checkJs: false,
      jsx: configuredOptions.jsx ?? ts.JsxEmit.ReactJSX,
      module: configuredOptions.module ?? ts.ModuleKind.NodeNext,
      moduleResolution: configuredOptions.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      // Avoid loading ambient packages unrelated to project-owned symbols.
      types: []
    },
    mode,
    warnings,
    configPath,
    configText: configTexts.join("\n")
  };
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
