import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runLspCallHierarchy,
  type LspStdioProcess
} from "./lspCallHierarchyClient.js";

describe("LSP call hierarchy client", () => {
  it("speaks framed JSON-RPC and recursively closes a bounded call graph", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-fake-lsp-"));
    try {
      await writeFile(path.join(projectPath, "sample.py"), [
        "def target(value):",
        "    return helper(value)",
        "",
        "def caller():",
        "    return target(1)"
      ].join("\n"));
      const fakeServer = createFakeLanguageServer(
        pathToFileURL(path.join(projectPath, "sample.py")).href
      );

      const report = await runLspCallHierarchy({
        command: "fake-language-server",
        args: ["--stdio"],
        projectPath,
        targetFile: "sample.py",
        symbol: "target",
        targetLine: 1,
        languageId: "python",
        maxDepth: 2,
        maxSymbols: 10,
        timeoutMs: 5_000,
        spawnProcess: () => fakeServer
      });

      expect(report.target.name).toBe("target");
      expect(report.incoming[0]?.from.name).toBe("caller");
      expect(report.outgoing[0]?.to.name).toBe("helper");
      expect(report.graph?.nodes.map((node) => node.item.name).sort()).toEqual([
        "caller", "helper", "outer", "target"
      ]);
      expect(report.graph?.edges).toHaveLength(3);
      expect(report.graph?.coverage).toMatchObject({
        max_depth: 2,
        max_symbols: 10,
        nodes_discovered: 4,
        nodes_expanded: 4,
        edges_discovered: 3,
        complete: true,
        truncated_reasons: []
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("records depth truncation instead of claiming a complete graph", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-fake-lsp-bounded-"));
    try {
      await writeFile(path.join(projectPath, "sample.py"), [
        "def target(value):",
        "    return helper(value)",
        "",
        "def caller():",
        "    return target(1)"
      ].join("\n"));
      const fakeServer = createFakeLanguageServer(
        pathToFileURL(path.join(projectPath, "sample.py")).href
      );

      const report = await runLspCallHierarchy({
        command: "fake-language-server",
        args: ["--stdio"],
        projectPath,
        targetFile: "sample.py",
        symbol: "target",
        targetLine: 1,
        languageId: "python",
        maxDepth: 1,
        maxSymbols: 10,
        timeoutMs: 5_000,
        spawnProcess: () => fakeServer
      });

      expect(report.graph?.nodes.map((node) => node.item.name).sort()).toEqual([
        "caller", "helper", "target"
      ]);
      expect(report.graph?.coverage.complete).toBe(false);
      expect(report.graph?.coverage.truncated_reasons).toContain("调用图达到 max_depth=1");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("records symbol-budget truncation with deterministic unique nodes", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-fake-lsp-symbols-"));
    try {
      await writeFile(path.join(projectPath, "sample.py"), [
        "def target(value):",
        "    return helper(value)",
        "",
        "def caller():",
        "    return target(1)"
      ].join("\n"));
      const fakeServer = createFakeLanguageServer(
        pathToFileURL(path.join(projectPath, "sample.py")).href
      );

      const report = await runLspCallHierarchy({
        command: "fake-language-server",
        args: ["--stdio"],
        projectPath,
        targetFile: "sample.py",
        symbol: "target",
        targetLine: 1,
        languageId: "python",
        maxDepth: 2,
        maxSymbols: 2,
        timeoutMs: 5_000,
        spawnProcess: () => fakeServer
      });

      expect(report.graph?.nodes).toHaveLength(2);
      expect(new Set(report.graph?.nodes.map((node) => node.id)).size).toBe(2);
      expect(report.graph?.coverage.complete).toBe(false);
      expect(report.graph?.coverage.truncated_reasons).toContain("调用图达到 max_symbols=2");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

function createFakeLanguageServer(targetUri: string): LspStdioProcess {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  let initializeId: number | undefined;
  const processLike: LspStdioProcess = {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      events.emit("exit", 0, null);
      return true;
    },
    once(event: "error" | "exit", listener: (...args: unknown[]) => void) {
      events.once(event, listener);
      return this;
    }
  } as LspStdioProcess;
  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const message = JSON.parse(
        buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
      ) as {
        id?: number | string;
        method?: string;
        params?: { item?: { name?: string } };
        result?: unknown;
      };
      buffer = buffer.subarray(bodyStart + length);
      if (message.id === "server-config" && message.method === undefined) {
        sendResponse(initializeId!, { capabilities: { callHierarchyProvider: true } });
        initializeId = undefined;
        continue;
      }
      if (message.id === undefined) continue;
      let result: unknown = null;
      if (message.method === "initialize") {
        initializeId = message.id as number;
        sendMessage({
          jsonrpc: "2.0",
          id: "server-config",
          method: "workspace/configuration",
          params: { items: [{ section: "python" }] }
        });
        continue;
      } else if (message.method === "textDocument/prepareCallHierarchy") {
        result = [callItem("target", 0, targetUri)];
      } else if (message.method === "callHierarchy/incomingCalls") {
        const name = message.params?.item?.name;
        if (name === "target") {
          result = [{
            from: callItem("caller", 3, targetUri),
            fromRanges: [callItem("caller", 4, targetUri).range]
          }];
        } else if (name === "caller") {
          result = [{
            from: callItem("outer", 8, targetUri),
            fromRanges: [callItem("outer", 9, targetUri).range]
          }];
        } else if (name === "helper") {
          // A real cycle: helper calls target, already represented by a known node.
          result = [{
            from: callItem("target", 0, targetUri),
            fromRanges: [callItem("target", 1, targetUri).range]
          }];
        } else {
          result = [];
        }
      } else if (message.method === "callHierarchy/outgoingCalls") {
        const name = message.params?.item?.name;
        if (name === "target") {
          result = [{
            to: callItem("helper", 6, targetUri),
            fromRanges: [callItem("target", 1, targetUri).range]
          }];
        } else if (name === "caller") {
          result = [{
            to: callItem("target", 0, targetUri),
            fromRanges: [callItem("caller", 4, targetUri).range]
          }];
        } else if (name === "outer") {
          result = [{
            to: callItem("caller", 3, targetUri),
            fromRanges: [callItem("outer", 9, targetUri).range]
          }];
        } else {
          result = [];
        }
      }
      sendResponse(message.id, result);
    }
  });
  return processLike;

  function sendResponse(id: number | string, result: unknown): void {
    sendMessage({ jsonrpc: "2.0", id, result });
  }

  function sendMessage(message: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(message));
    stdout.write(Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"));
    stdout.write(payload);
  }
}

function callItem(name: string, line: number, uri: string) {
  const range = { start: { line, character: 0 }, end: { line, character: 20 } };
  return { name, kind: 12, uri, range, selectionRange: range };
}
