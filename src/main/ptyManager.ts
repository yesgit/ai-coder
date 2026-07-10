import type { IPty } from "@lydell/node-pty";
import { spawn } from "@lydell/node-pty";

interface PtyEntry {
  pty: IPty;
  projectPath: string;
}

export class PtyManager {
  private terminals = new Map<string, PtyEntry>();

  create(
    id: string,
    projectPath: string,
    cols: number,
    rows: number,
    onData: (data: string) => void
  ): void {
    this.destroy(id);

    const shell = process.env.SHELL || "/bin/bash";
    const pty = spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: projectPath,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    pty.onData((data: string) => {
      onData(data);
    });

    pty.onExit(({ exitCode }) => {
      onData(`\r\n[终端已退出，退出码: ${exitCode}]\r\n`);
      this.terminals.delete(id);
    });

    this.terminals.set(id, { pty, projectPath });
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.pty.resize(cols, rows);
  }

  destroy(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.pty.kill();
    this.terminals.delete(id);
  }

  destroyAll(): void {
    for (const id of this.terminals.keys()) {
      this.destroy(id);
    }
  }
}
