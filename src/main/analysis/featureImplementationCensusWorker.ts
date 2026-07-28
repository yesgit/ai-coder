import { parentPort, workerData } from "node:worker_threads";
import {
  censusFeatureImplementations,
  formatFeatureImplementationCensusToolResult,
  type FeatureImplementationCensusInput
} from "./featureImplementationCensus.js";

if (!parentPort) {
  throw new Error("功能实现候选普查 Worker 缺少 parentPort");
}

try {
  const report = censusFeatureImplementations(
    workerData as FeatureImplementationCensusInput
  );
  parentPort.postMessage({
    ok: true,
    result: {
      tool_result: formatFeatureImplementationCensusToolResult(report),
      report: {
        status: report.status,
        report_digest: report.report_digest,
        candidate_accounting: report.candidate_accounting,
        selected_targets: report.selected_targets,
        unresolved: report.unresolved,
        coverage: {
          files_scanned: report.coverage.files_scanned,
          symbols_indexed: report.coverage.symbols_indexed,
          graph_edges: report.coverage.graph_edges
        }
      }
    }
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error)
  });
}
