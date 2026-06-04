import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectOnboardingStatus } from "../../shared/types.js";

interface OnboardingConfirmation {
  project_path: string;
  claude_md_hash: string;
  confirmed_at: string;
  confirmed_by: "local-user";
}

export class OnboardingStore {
  constructor(private readonly storeDir = path.join(os.homedir(), ".ai-coder", "onboarding")) {}

  async getStatus(projectPath: string): Promise<ProjectOnboardingStatus> {
    const normalizedProjectPath = path.resolve(projectPath);
    const claudeMdPath = path.join(normalizedProjectPath, "CLAUDE.md");
    const claudeMd = await readOptionalFile(claudeMdPath);
    const confirmation = await this.readConfirmation(normalizedProjectPath);

    if (claudeMd === null) {
      return {
        status: "not_started",
        project_path: normalizedProjectPath,
        claude_md_path: claudeMdPath,
        claude_md_exists: false
      };
    }

    const claudeMdHash = hashContent(claudeMd);
    if (confirmation?.claude_md_hash === claudeMdHash) {
      return {
        status: "confirmed",
        project_path: normalizedProjectPath,
        claude_md_path: claudeMdPath,
        claude_md_exists: true,
        claude_md_hash: claudeMdHash,
        confirmed_at: confirmation.confirmed_at,
        confirmed_by: confirmation.confirmed_by
      };
    }

    return {
      status: confirmation ? "pending_review" : "claude_md_exists",
      project_path: normalizedProjectPath,
      claude_md_path: claudeMdPath,
      claude_md_exists: true,
      claude_md_hash: claudeMdHash
    };
  }

  async confirm(projectPath: string): Promise<ProjectOnboardingStatus> {
    const normalizedProjectPath = path.resolve(projectPath);
    const claudeMdPath = path.join(normalizedProjectPath, "CLAUDE.md");
    const claudeMd = await readOptionalFile(claudeMdPath);
    if (claudeMd === null) {
      throw new Error(`CLAUDE.md not found: ${claudeMdPath}`);
    }

    const confirmation: OnboardingConfirmation = {
      project_path: normalizedProjectPath,
      claude_md_hash: hashContent(claudeMd),
      confirmed_at: new Date().toISOString(),
      confirmed_by: "local-user"
    };
    await fs.mkdir(this.storeDir, { recursive: true });
    await fs.writeFile(this.confirmationPath(normalizedProjectPath), JSON.stringify(confirmation, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    return this.getStatus(normalizedProjectPath);
  }

  private async readConfirmation(projectPath: string): Promise<OnboardingConfirmation | null> {
    try {
      const raw = await fs.readFile(this.confirmationPath(projectPath), "utf8");
      return JSON.parse(raw) as OnboardingConfirmation;
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      throw error;
    }
  }

  private confirmationPath(projectPath: string): string {
    return path.join(this.storeDir, `${hashContent(projectPath)}.json`);
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
