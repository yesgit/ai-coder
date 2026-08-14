import { useEffect, useState } from "react";
import type {
  TaskAutomationSettings,
  TaskPlatformConfig,
  TaskPlatformKind,
  TaskProjectMapping,
  WorkflowTemplate
} from "../../shared/types.js";
import TaskPlatformSettings from "./TaskPlatformSettings.js";
import "./styles.css";

const PLATFORM_PRESETS: { kind: TaskPlatformKind; label: string; urlPlaceholder: string }[] = [
  { kind: "jira_cloud", label: "Jira Cloud", urlPlaceholder: "https://your-domain.atlassian.net" },
  { kind: "jira_server", label: "Jira Server", urlPlaceholder: "https://jira.your-company.com" },
  { kind: "pingcode", label: "PingCode", urlPlaceholder: "https://your-company.pingcode.com" }
];

function emptyPlatformConfig(kind: TaskPlatformKind): TaskPlatformConfig {
  return { kind, enabled: false, base_url: "", credentials: { stored: false }, project_mappings: [] };
}

function emptyMapping(): TaskProjectMapping {
  return {
    platform_project_id: "",
    local_repo_path: "",
    workflow_id: "",
    default_base_branch: "main",
    branch_prefix: "feature/",
    target_labels: [],
    exclude_statuses: []
  };
}

/** 输入框与字符串数组的无损往返：仅按逗号切分，空白原样保留，trim/filter 留到保存时。 */

/**
 * 任务自动化配置编辑器：总开关、平台地址与项目映射、MR Review 开关。
 * 编辑先落到本地 draft，点「保存配置」统一提交并立即生效。
 */
export default function TaskAutomationSettingsEditor() {
  const [draft, setDraft] = useState<TaskAutomationSettings | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    window.aiCoder.getSettings().then((settings) => {
      setDraft(structuredClone(settings.task_automation));
    });
    window.aiCoder.listWorkflows().then((result) => {
      setWorkflows(result.workflows);
    });
  }, []);

  if (!draft) return null;

  const markDirty = () => setSaveState("idle");

  const updateDraft = (patch: Partial<TaskAutomationSettings>) => {
    markDirty();
    setDraft({ ...draft, ...patch });
  };

  const getPlatform = (kind: TaskPlatformKind): TaskPlatformConfig =>
    draft.platforms.find((p) => p.kind === kind) ?? emptyPlatformConfig(kind);

  const updatePlatform = (kind: TaskPlatformKind, patch: Partial<TaskPlatformConfig>) => {
    markDirty();
    const existing = draft.platforms.find((p) => p.kind === kind);
    const next = { ...(existing ?? emptyPlatformConfig(kind)), ...patch };
    setDraft({
      ...draft,
      platforms: [...draft.platforms.filter((p) => p.kind !== kind), next]
    });
  };

  const updateMapping = (kind: TaskPlatformKind, index: number, patch: Partial<TaskProjectMapping>) => {
    const config = getPlatform(kind);
    const mappings = config.project_mappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
    updatePlatform(kind, { project_mappings: mappings });
  };

  const pickRepoDirectory = async (kind: TaskPlatformKind, index: number) => {
    const selected = await window.aiCoder.selectProjectDirectory();
    if (selected) {
      updateMapping(kind, index, { local_repo_path: selected });
    }
  };

  const handleSave = async () => {
    // 保留的映射必须三要素齐全，缺项会导致侦察静默跳过且难以排查
    for (const platform of draft.platforms) {
      const incomplete = platform.project_mappings
        .filter((m) => m.platform_project_id.trim() || m.local_repo_path.trim())
        .find((m) => !m.platform_project_id.trim() || !m.local_repo_path.trim() || !m.workflow_id);
      if (incomplete) {
        const platformLabel = PLATFORM_PRESETS.find((p) => p.kind === platform.kind)?.label ?? platform.kind;
        setSaveError(`${platformLabel} 的映射「${incomplete.platform_project_id.trim() || "未命名"}」缺少平台项目 ID、本地仓库或执行工作流`);
        setSaveState("error");
        return;
      }
    }
    setSaving(true);
    setSaveState("idle");
    try {
      // 丢弃完全未配置的平台与空映射行，避免在 settings.json 里积累垃圾
      const cleaned: TaskAutomationSettings = {
        ...draft,
        polling_interval_seconds: Math.max(30, Math.round(draft.polling_interval_seconds) || 300),
        platforms: draft.platforms
          .map((p) => ({
            ...p,
            base_url: p.base_url.trim(),
            project_mappings: p.project_mappings
              .filter((m) => m.platform_project_id.trim() || m.local_repo_path.trim())
              .map((m) => ({
                ...m,
                platform_project_id: m.platform_project_id.trim(),
                local_repo_path: m.local_repo_path.trim(),
                target_labels: m.target_labels.map((s) => s.trim()).filter(Boolean),
                exclude_statuses: m.exclude_statuses.map((s) => s.trim()).filter(Boolean)
              }))
          }))
          .filter((p) => p.enabled || p.base_url || p.project_mappings.length > 0)
      };
      const saved = await window.aiCoder.updateTaskAutomationSettings(cleaned);
      setDraft(structuredClone(saved));
      setSaveState("saved");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveState("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="automation-settings-editor">
      {/* 总开关 */}
      <div className="review-toggle-row">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => updateDraft({ enabled: e.target.checked })}
          />
          <span className="toggle-track" />
        </label>
        <div className="review-toggle-text">
          <strong>启用任务自动化</strong>
          <small>开启后按设定间隔自动侦察各平台待办并认领</small>
        </div>
        <div className="polling-interval-field">
          <label>侦察间隔（秒）</label>
          <input
            type="number"
            min={30}
            step={30}
            value={draft.polling_interval_seconds}
            onChange={(e) => updateDraft({ polling_interval_seconds: Number(e.target.value) || 30 })}
          />
        </div>
      </div>

      {/* 平台配置卡片 */}
      {PLATFORM_PRESETS.map((preset) => {
        const config = getPlatform(preset.kind);
        return (
          <div key={preset.kind} className={`platform-card${config.enabled ? " enabled" : ""}`}>
            <div className="platform-card-header">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => updatePlatform(preset.kind, { enabled: e.target.checked })}
                />
                <span className="toggle-track" />
              </label>
              <strong>{preset.label}</strong>
            </div>

            {config.enabled && (
              <div className="platform-card-body">
                <div className="settings-row">
                  <label>平台地址</label>
                  <input
                    type="url"
                    value={config.base_url}
                    placeholder={preset.urlPlaceholder}
                    onChange={(e) => updatePlatform(preset.kind, { base_url: e.target.value })}
                  />
                </div>

                {/* 项目映射 */}
                <div className="mapping-section">
                  <div className="mapping-section-header">
                    <label>项目映射</label>
                    <button
                      className="secondary small"
                      onClick={() =>
                        updatePlatform(preset.kind, {
                          project_mappings: [...config.project_mappings, emptyMapping()]
                        })
                      }
                    >
                      + 添加映射
                    </button>
                  </div>
                  {config.project_mappings.length === 0 ? (
                    <small className="muted">未配置映射。建议至少添加一条，将平台项目关联到本地仓库。</small>
                  ) : (
                    config.project_mappings.map((mapping, index) => (
                      <div key={index} className="mapping-card">
                        <div className="mapping-card-header">
                          <strong>{mapping.platform_project_id.trim() || `映射 ${index + 1}`}</strong>
                          <button
                            className="mapping-remove"
                            title="删除映射"
                            onClick={() =>
                              updatePlatform(preset.kind, {
                                project_mappings: config.project_mappings.filter((_, i) => i !== index)
                              })
                            }
                          >
                            ✕
                          </button>
                        </div>
                        <div className="mapping-grid">
                          <div className="settings-row">
                            <label>平台项目 ID</label>
                            <input
                              value={mapping.platform_project_id}
                              placeholder="如 PROJ"
                              onChange={(e) =>
                                updateMapping(preset.kind, index, { platform_project_id: e.target.value })
                              }
                            />
                          </div>
                          <div className="settings-row">
                            <label>本地仓库</label>
                            <div className="repo-path-row">
                              <input
                                value={mapping.local_repo_path}
                                placeholder="/path/to/repo"
                                onChange={(e) =>
                                  updateMapping(preset.kind, index, { local_repo_path: e.target.value })
                                }
                              />
                              <button
                                className="secondary small"
                                onClick={() => void pickRepoDirectory(preset.kind, index)}
                              >
                                选择
                              </button>
                            </div>
                          </div>
                          <div className="settings-row">
                            <label>执行工作流</label>
                            <select
                              value={mapping.workflow_id}
                              onChange={(e) =>
                                updateMapping(preset.kind, index, { workflow_id: e.target.value })
                              }
                            >
                              <option value="" disabled>
                                选择工作流
                              </option>
                              {workflows.map((wf) => (
                                <option key={wf.id} value={wf.id}>
                                  {wf.name}（{wf.id}）
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="settings-row">
                            <label>基础分支</label>
                            <input
                              value={mapping.default_base_branch}
                              placeholder="main"
                              onChange={(e) =>
                                updateMapping(preset.kind, index, { default_base_branch: e.target.value })
                              }
                            />
                          </div>
                          <div className="settings-row">
                            <label>分支前缀</label>
                            <input
                              value={mapping.branch_prefix}
                              placeholder="feature/"
                              onChange={(e) =>
                                updateMapping(preset.kind, index, { branch_prefix: e.target.value })
                              }
                            />
                          </div>
                          <div className="settings-row">
                            <label>目标标签</label>
                            <input
                              value={mapping.target_labels.join(",")}
                              placeholder="逗号分隔，如 ai-coder, auto"
                              onChange={(e) =>
                                updateMapping(preset.kind, index, { target_labels: e.target.value.split(",") })
                              }
                            />
                          </div>
                          <div className="settings-row">
                            <label>排除状态</label>
                            <input
                              value={mapping.exclude_statuses.join(",")}
                              placeholder="逗号分隔，如 Done, Closed"
                              onChange={(e) =>
                                updateMapping(preset.kind, index, {
                                  exclude_statuses: e.target.value.split(",")
                                })
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* 平台凭证 */}
                <TaskPlatformSettings platform={preset.kind} platformLabel={preset.label} />
              </div>
            )}
          </div>
        );
      })}

      {/* MR Review 自动处理 */}
      <div className="review-toggle-row">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={draft.review_handling.enabled}
            onChange={(e) =>
              updateDraft({
                review_handling: { ...draft.review_handling, enabled: e.target.checked }
              })
            }
          />
          <span className="toggle-track" />
        </label>
        <div className="review-toggle-text">
          <strong>MR Review 自动处理</strong>
          <small>
            {draft.review_handling.enabled
              ? `已启用：每 ${Math.round(draft.review_handling.polling_interval_seconds / 60)} 分钟轮询评论并自动回复`
              : "已关闭"}
          </small>
        </div>
      </div>

      {/* Git 托管凭证（提 MR 用） */}
      <div className="mapping-section">
        <div className="mapping-section-header">
          <label>Git 托管凭证</label>
        </div>
        <small className="muted">用于在 GitHub / GitLab 上提交 MR 与处理 Review。</small>
        <TaskPlatformSettings platform="git_host" platformLabel="Git Host" />
      </div>

      {/* 保存 */}
      <div className="settings-save-row">
        <button className="primary" onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : "保存配置"}
        </button>
        {saveState === "saved" && <span className="save-feedback ok">已保存并生效</span>}
        {saveState === "error" && <span className="save-feedback error">保存失败：{saveError}</span>}
      </div>
    </div>
  );
}
