import { Worker } from "node:worker_threads";
import type {
  FeatureImplementationCensusInput,
  FeatureImplementationCensusReport
} from "./featureImplementationCensus.js";

export interface FeatureCensusWorkerResult {
  tool_result: string;
  report: Pick<
    FeatureImplementationCensusReport,
    "status" | "report_digest" | "candidate_accounting" | "review_frontier" | "selected_targets" | "unresolved" | "closure"
  > & {
    coverage: Pick<
      FeatureImplementationCensusReport["coverage"],
      "files_scanned" | "symbols_indexed" | "graph_edges"
    >;
  };
}

type FeatureCensusWorkerMessage =
  | { ok: true; result: FeatureCensusWorkerResult }
  | { ok: false; error: string };

/**
 * Runs the CPU-heavy TypeScript census outside Electron's main thread.
 * Terminating a Worker is preemptive, so the UI's Stop action remains usable
 * even while TypeScript is synchronously building a large project graph.
 */
export function censusFeatureImplementationsInWorker(
  input: FeatureImplementationCensusInput,
  signal?: AbortSignal,
  workerUrl = new URL("./featureImplementationCensusWorker.js", import.meta.url)
): Promise<FeatureCensusWorkerResult> {
  if (signal?.aborted) {
    return Promise.reject(featureCensusAbortError());
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (
      callback: () => void,
      terminate = false
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate();
      callback();
    };
    const onAbort = () => {
      finish(() => reject(featureCensusAbortError()), true);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: FeatureCensusWorkerMessage) => {
      if (message?.ok === true) {
        finish(() => resolve(message.result));
      } else {
        finish(
          () => reject(new Error(message?.error || "功能实现候选普查 Worker 返回未知错误")),
          true
        );
      }
    });
    worker.once("error", (error) => {
      finish(() => reject(error), true);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      finish(() => reject(new Error(`功能实现候选普查 Worker 提前退出（code=${code}）`)));
    });
  });
}

function featureCensusAbortError(): Error {
  const error = new Error("功能实现候选普查已由用户中止");
  error.name = "AbortError";
  return error;
}
