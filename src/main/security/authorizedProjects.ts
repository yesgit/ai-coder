import fs from "node:fs/promises";
import path from "node:path";

export class AuthorizedProjects {
  private readonly paths = new Set<string>();

  async authorize(projectPath: string): Promise<string> {
    const resolved = await resolveDirectory(projectPath);
    this.paths.add(resolved);
    return resolved;
  }

  async assertAuthorized(projectPath: string): Promise<string> {
    const resolved = await resolveDirectory(projectPath);
    if (!this.paths.has(resolved)) {
      throw new Error(`Project path is not authorized: ${projectPath}`);
    }
    return resolved;
  }

  async authorizeMatching(expectedProjectPath: string, selectedProjectPath: string): Promise<string> {
    const [expected, selected] = await Promise.all([
      resolveDirectory(expectedProjectPath),
      resolveDirectory(selectedProjectPath)
    ]);
    if (expected !== selected) {
      throw new Error(`Selected directory does not match the historical project: ${expectedProjectPath}`);
    }
    this.paths.add(expected);
    return expected;
  }
}

async function resolveDirectory(projectPath: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(projectPath));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
  }
  return resolved;
}
