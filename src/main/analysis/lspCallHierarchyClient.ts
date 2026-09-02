import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspCallHierarchyItem {
  name: string;
  kind?: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  data?: unknown;
}

interface LspIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyRequest {
  command: string;
  args: string[];
  projectPath: string;
  targetFile: string;
  symbol: string;
  targetLine?: number;
  languageId: string;
  timeoutMs?: number;
  /** Maximum number of caller/callee edges traversed away from the target. */
  maxDepth?: number;
  /** Hard bound for unique overload-aware hierarchy items. */
  maxSymbols?: number;
  /** Deterministic transport seam for tests and embedded runtimes. */
  spawnProcess?: LspProcessFactory;
}

export interface LspStdioProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  exitCode: number | null;
  kill(): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type LspProcessFactory = (
  command: string,
  args: string[],
  cwd: string
) => LspStdioProcess;

export interface LspCallHierarchyReport {
  target: LspCallHierarchyItem;
  incoming: LspIncomingCall[];
  outgoing: LspOutgoingCall[];
  graph?: {
    nodes: Array<{
      id: string;
      item: LspCallHierarchyItem;
      depth: number;
      expanded: boolean;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      callsiteUri: string;
      fromRanges: LspRange[];
      discoveredAtDepth: number;
    }>;
    coverage: {
      max_depth: number;
      max_symbols: number;
      nodes_discovered: number;
      nodes_expanded: number;
      edges_discovered: number;
      complete: boolean;
      truncated_reasons: string[];
    };
  };
}

type LspCallHierarchyGraph = NonNullable<LspCallHierarchyReport["graph"]>;

export async function runLspCallHierarchy(
  input: LspCallHierarchyRequest
): Promise<LspCallHierarchyReport> {
  const absoluteFile = path.isAbsolute(input.targetFile)
    ? path.resolve(input.targetFile)
    : path.resolve(input.projectPath, input.targetFile);
  const source = await readFile(absoluteFile, "utf8");
  const lines = source.split(/\r?\n/);
  const targetLine = Math.max(1, input.targetLine ?? findSymbolLine(lines, input.symbol));
  const sourceLine = lines[targetLine - 1] ?? "";
  const symbolColumn = Math.max(0, sourceLine.indexOf(input.symbol));
  const uri = pathToFileURL(absoluteFile).href;
  const rootUri = pathToFileURL(path.resolve(input.projectPath)).href;
  const client = new StdioJsonRpcClient(
    input.command,
    input.args,
    input.projectPath,
    input.timeoutMs ?? 15_000,
    input.spawnProcess
  );

  try {
    await client.start();
    const initialized = await client.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          callHierarchy: { dynamicRegistration: false }
        }
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(input.projectPath) }]
    });
    const capabilities = isRecord(initialized) && isRecord(initialized.capabilities)
      ? initialized.capabilities
      : undefined;
    if (capabilities?.callHierarchyProvider === false) {
      throw new Error(`语言服务器明确声明不支持 Call Hierarchy：${input.languageId}`);
    }
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: input.languageId,
        version: 1,
        text: source
      }
    });
    let items: LspCallHierarchyItem[] = [];
    for (const delayMs of [0, 200, 750]) {
      if (delayMs > 0) await delay(delayMs);
      const prepared = await client.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri },
        position: { line: targetLine - 1, character: symbolColumn }
      });
      items = asArray(prepared).filter(isCallHierarchyItem);
      if (items.length > 0) break;
    }
    const target = items.find((item) => (
      item.name === input.symbol && sameFileUri(item.uri, absoluteFile)
    ));
    if (!target) {
      throw new Error(
        `语言服务器未返回精确调用层级目标：${input.targetFile}#${input.symbol}:${targetLine}`
        + `；candidates=${items.map((item) => `${item.name}@${item.uri}`).join(",") || "none"}`
      );
    }
    const hierarchy = await collectCallHierarchyGraph(
      client,
      target,
      input.maxDepth ?? 2,
      input.maxSymbols ?? 100
    );
    return {
      target,
      incoming: hierarchy.incoming,
      outgoing: hierarchy.outgoing,
      graph: hierarchy.graph
    };
  } finally {
    await client.stop();
  }
}

async function collectCallHierarchyGraph(
  client: StdioJsonRpcClient,
  target: LspCallHierarchyItem,
  requestedDepth: number,
  requestedSymbols: number
): Promise<{
  incoming: LspIncomingCall[];
  outgoing: LspOutgoingCall[];
  graph: LspCallHierarchyGraph;
}> {
  const maxDepth = Math.min(8, Math.max(0, Math.floor(requestedDepth)));
  const maxSymbols = Math.min(500, Math.max(1, Math.floor(requestedSymbols)));
  const nodes = new Map<string, {
    id: string;
    item: LspCallHierarchyItem;
    depth: number;
    expanded: boolean;
  }>();
  const edges = new Map<string, LspCallHierarchyGraph["edges"][number]>();
  const queue: Array<{ key: string; item: LspCallHierarchyItem; depth: number }> = [];
  const truncatedReasons: string[] = [];
  let rootIncoming: LspIncomingCall[] = [];
  let rootOutgoing: LspOutgoingCall[] = [];

  const appendNode = (item: LspCallHierarchyItem, depth: number): string | undefined => {
    const key = callHierarchyItemKey(item);
    const existing = nodes.get(key);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return key;
    }
    if (nodes.size >= maxSymbols) {
      truncatedReasons.push(`调用图达到 max_symbols=${maxSymbols}`);
      return undefined;
    }
    const node = { id: `node-${nodes.size + 1}`, item, depth, expanded: false };
    nodes.set(key, node);
    queue.push({ key, item, depth });
    return key;
  };
  appendNode(target, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = nodes.get(current.key);
    if (!currentNode || currentNode.expanded) continue;
    let incoming: LspIncomingCall[];
    let outgoing: LspOutgoingCall[];
    try {
      const [incomingRaw, outgoingRaw] = await Promise.all([
        client.request("callHierarchy/incomingCalls", { item: current.item }),
        client.request("callHierarchy/outgoingCalls", { item: current.item })
      ]);
      incoming = asArray(incomingRaw).filter(isIncomingCall);
      outgoing = asArray(outgoingRaw).filter(isOutgoingCall);
    } catch (error) {
      if (current.depth === 0) throw error;
      truncatedReasons.push(
        `无法展开 ${current.item.name}@${current.item.uri}:${current.item.selectionRange.start.line + 1}：`
        + (error instanceof Error ? error.message : String(error))
      );
      continue;
    }
    currentNode.expanded = true;
    if (current.depth === 0) {
      rootIncoming = incoming;
      rootOutgoing = outgoing;
    }

    for (const call of incoming) {
      appendHierarchyEdge({
        source: call.from,
        destination: current.item,
        ranges: call.fromRanges,
        callsiteUri: call.from.uri,
        depth: current.depth,
        currentDepth: current.depth,
        maxDepth,
        appendNode,
        nodes,
        edges,
        truncatedReasons
      });
    }
    for (const call of outgoing) {
      appendHierarchyEdge({
        source: current.item,
        destination: call.to,
        ranges: call.fromRanges,
        callsiteUri: current.item.uri,
        depth: current.depth,
        currentDepth: current.depth,
        maxDepth,
        appendNode,
        nodes,
        edges,
        truncatedReasons
      });
    }
  }

  const graphNodes = [...nodes.values()];
  const graphEdges = [...edges.values()];
  return {
    incoming: rootIncoming,
    outgoing: rootOutgoing,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
      coverage: {
        max_depth: maxDepth,
        max_symbols: maxSymbols,
        nodes_discovered: graphNodes.length,
        nodes_expanded: graphNodes.filter((node) => node.expanded).length,
        edges_discovered: graphEdges.length,
        complete: truncatedReasons.length === 0,
        truncated_reasons: [...new Set(truncatedReasons)]
      }
    }
  };
}

function appendHierarchyEdge(input: {
  source: LspCallHierarchyItem;
  destination: LspCallHierarchyItem;
  ranges: LspRange[];
  callsiteUri: string;
  depth: number;
  currentDepth: number;
  maxDepth: number;
  appendNode: (item: LspCallHierarchyItem, depth: number) => string | undefined;
  nodes: Map<string, { id: string; item: LspCallHierarchyItem; depth: number; expanded: boolean }>;
  edges: Map<string, LspCallHierarchyGraph["edges"][number]>;
  truncatedReasons: string[];
}): void {
  const sourceKey = callHierarchyItemKey(input.source);
  const destinationKey = callHierarchyItemKey(input.destination);
  const currentIsSource = input.nodes.has(sourceKey);
  const peer = currentIsSource ? input.destination : input.source;
  const nextDepth = input.currentDepth + 1;
  if (!input.nodes.has(callHierarchyItemKey(peer))) {
    if (nextDepth > input.maxDepth) {
      input.truncatedReasons.push(`调用图达到 max_depth=${input.maxDepth}`);
      return;
    }
    if (!input.appendNode(peer, nextDepth)) return;
  }
  const sourceNode = input.nodes.get(sourceKey);
  const destinationNode = input.nodes.get(destinationKey);
  if (!sourceNode || !destinationNode) return;
  const edgeKey = [
    sourceKey,
    destinationKey,
    input.callsiteUri,
    ...input.ranges.map(rangeKey)
  ].join("\u0000");
  if (input.edges.has(edgeKey)) return;
  input.edges.set(edgeKey, {
    id: `edge-${input.edges.size + 1}`,
    from: sourceNode.id,
    to: destinationNode.id,
    callsiteUri: input.callsiteUri,
    fromRanges: input.ranges,
    discoveredAtDepth: input.depth
  });
}

function callHierarchyItemKey(item: LspCallHierarchyItem): string {
  return [
    item.uri,
    item.name,
    item.selectionRange.start.line,
    item.selectionRange.start.character,
    item.selectionRange.end.line,
    item.selectionRange.end.character,
    item.detail ?? ""
  ].join("\u0000");
}

function rangeKey(range: LspRange): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  ].join(":");
}

class StdioJsonRpcClient {
  private child: LspStdioProcess | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly timeoutMs: number,
    private readonly spawnProcess: LspProcessFactory = defaultSpawnProcess
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = this.spawnProcess(this.command, this.args, this.cwd);
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8_000);
    });
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      this.rejectAll(new Error(
        `语言服务器提前退出：code=${code ?? "null"}, signal=${signal ?? "null"}`
        + `；pending=${[...this.pending.keys()].join(",")}`
        + (this.stderr ? `；stderr=${this.stderr}` : "")
      ));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 25);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `语言服务器请求超时：${method} (${timeoutMs}ms)`
          + (this.stderr ? `；stderr=${this.stderr}` : "")
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!child.killed && child.exitCode === null) {
      try {
        await this.request("shutdown", null, Math.min(this.timeoutMs, 1_000));
        this.notify("exit", null);
      } catch {
        // A failed/partial initialization may not support shutdown. The bounded
        // process cleanup below remains authoritative.
      }
    }
    if (child.exitCode === null && !child.killed) child.kill();
    this.child = undefined;
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("语言服务器 stdin 不可写");
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
    child.stdin.write(Buffer.concat([header, payload]));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.rejectAll(new Error(`语言服务器响应缺少 Content-Length：${header}`));
        return;
      }
      const length = Number(lengthMatch[1]!);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handle(JSON.parse(body) as unknown);
      } catch (error) {
        this.rejectAll(new Error(
          `语言服务器响应 JSON 无效：${error instanceof Error ? error.message : String(error)}`
        ));
      }
    }
  }

  private handle(message: unknown): void {
    if (!isRecord(message)) return;
    if (
      typeof message.method === "string"
      && (typeof message.id === "number" || typeof message.id === "string")
    ) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: serverRequestResult(message.method, message.params)
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(new Error(
        `语言服务器请求失败：${String(message.error.message ?? JSON.stringify(message.error))}`
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function serverRequestResult(method: string, params: unknown): unknown {
  if (method === "workspace/configuration") {
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
    return items.map(() => null);
  }
  if (method === "workspace/workspaceFolders") return null;
  if (method === "workspace/applyEdit") {
    return { applied: false, failureReason: "AI Coder language analysis is read-only" };
  }
  // Registration, progress creation, refresh requests and unknown extensions
  // are acknowledged so an analysis-only server cannot deadlock waiting for a
  // UI client capability that AI Coder intentionally does not implement.
  return null;
}

function defaultSpawnProcess(command: string, args: string[], cwd: string): LspStdioProcess {
  return spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

function findSymbolLine(lines: string[], symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPatterns = [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class)\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native)\\s+)*(?:class|interface|enum|record)\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:(?:export|public|protected|private|static|final|abstract|async|const|let|var)\\s+)+[^=;{}]*\\b${escaped}\\s*(?:[=(])`)
  ];
  const index = lines.findIndex((line) => declarationPatterns.some((pattern) => pattern.test(line)));
  const fallback = index >= 0 ? index : lines.findIndex((line) => line.includes(symbol));
  if (fallback < 0) throw new Error(`目标文件中找不到符号文本：${symbol}`);
  return fallback + 1;
}

function sameFileUri(uri: string, absoluteFile: string): boolean {
  if (!uri.startsWith("file:")) return false;
  try {
    return path.resolve(fileURLToPath(uri)) === path.resolve(absoluteFile);
  } catch {
    return false;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isCallHierarchyItem(value: unknown): value is LspCallHierarchyItem {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.uri === "string"
    && isRange(value.range)
    && isRange(value.selectionRange);
}

function isIncomingCall(value: unknown): value is LspIncomingCall {
  return isRecord(value)
    && isCallHierarchyItem(value.from)
    && Array.isArray(value.fromRanges)
    && value.fromRanges.every(isRange);
}

function isOutgoingCall(value: unknown): value is LspOutgoingCall {
  return isRecord(value)
    && isCallHierarchyItem(value.to)
    && Array.isArray(value.fromRanges)
    && value.fromRanges.every(isRange);
}
