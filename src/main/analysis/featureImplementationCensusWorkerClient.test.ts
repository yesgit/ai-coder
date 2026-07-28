import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { censusFeatureImplementationsInWorker } from "./featureImplementationCensusWorkerClient.js";

const input = {
  projectPath: "/tmp/project",
  feature: "test feature"
};

describe("censusFeatureImplementationsInWorker", () => {
  it("keeps the caller event loop responsive while worker CPU is busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "feature-census-worker-"));
    const workerPath = path.join(root, "busy-worker.mjs");
    await writeFile(workerPath, `
import { parentPort } from "node:worker_threads";
const until = Date.now() + 200;
while (Date.now() < until) {}
parentPort.postMessage({ ok: true, result: { tool_result: "done", report: { marker: "done" } } });
`);
    try {
      const work = censusFeatureImplementationsInWorker(
        input,
        undefined,
        pathToFileURL(workerPath)
      );
      const first = await Promise.race([
        work.then(() => "worker"),
        new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 20))
      ]);
      expect(first).toBe("timer");
      await expect(work).resolves.toMatchObject({
        tool_result: "done",
        report: { marker: "done" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a busy worker when the session aborts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "feature-census-worker-abort-"));
    const workerPath = path.join(root, "busy-worker.mjs");
    await writeFile(workerPath, `
import { parentPort } from "node:worker_threads";
const until = Date.now() + 5000;
while (Date.now() < until) {}
parentPort.postMessage({ ok: true, result: { tool_result: "too-late", report: { marker: "too-late" } } });
`);
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const work = censusFeatureImplementationsInWorker(
        input,
        controller.signal,
        pathToFileURL(workerPath)
      );
      setTimeout(() => controller.abort(), 20);
      await expect(work).rejects.toMatchObject({
        name: "AbortError",
        message: "功能实现候选普查已由用户中止"
      });
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
