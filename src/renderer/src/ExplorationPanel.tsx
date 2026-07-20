import type { ExplorationCheckpoint } from "../../shared/types.js";

interface ExplorationPanelProps {
  checkpoints?: ExplorationCheckpoint[];
}

const DISPOSITION_LABEL: Record<ExplorationCheckpoint["disposition"], string> = {
  continue: "探索中",
  verify: "验证中",
  complete: "已闭合",
  blocked: "受阻"
};

export default function ExplorationPanel({ checkpoints }: ExplorationPanelProps) {
  const checkpoint = checkpoints?.at(-1);

  return (
    <section className="stages-panel exploration-panel" aria-live="polite">
      <div className="exploration-heading">
        <h3>工作记忆</h3>
        <span className={`exploration-status ${checkpoint?.disposition ?? "empty"}`}>
          {checkpoint ? `r${checkpoint.revision} · ${DISPOSITION_LABEL[checkpoint.disposition]}` : "等待建立"}
        </span>
      </div>

      {checkpoint ? (
        <>
          <pre className="exploration-memory">{checkpoint.text}</pre>
          {checkpoint.next_action && (
            <div className="exploration-next">
              <small className="muted">下一步</small>
              <span>{checkpoint.next_action}</span>
            </div>
          )}
        </>
      ) : (
        <div className="exploration-empty">
          Agent 开始执行后，已确认信息、待探索问题和下一步会持续沉淀在这里。
        </div>
      )}
    </section>
  );
}
