import path from "node:path";

export function resolveCarefulCoderPluginPath(options: {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, "plugins", "careful-coder")
    : path.join(options.appPath, "plugins", "careful-coder");
}
