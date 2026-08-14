import { useState } from "react";
import "./styles.css";

interface TaskPlatformSettingsProps {
  /** 平台标识（jira_cloud / jira_server / pingcode / git_host）。 */
  platform: string;
  /** 展示用平台名。 */
  platformLabel: string;
}

/**
 * 单平台凭证配置：Token 输入 + 保存 + 连接测试。
 */
export default function TaskPlatformSettings({ platform, platformLabel }: TaskPlatformSettingsProps) {
  const [token, setToken] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setTestResult(null);
    setSaved(false);
    try {
      await window.aiCoder.setPlatformCredentials(platform, token.trim());
      setToken("");
      setSaved(true);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setSaved(false);
    try {
      const result = await window.aiCoder.testPlatformConnection(platform);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="task-platform-settings">
      <div className="settings-row">
        <label>{platformLabel} 凭证</label>
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setSaved(false);
          }}
          placeholder={platform === "jira_cloud" ? "email:api_token" : "API Token"}
        />
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving || !token.trim()} className="primary">
          {saving ? "保存中..." : "保存凭证"}
        </button>
        <button onClick={handleTest} className="secondary">
          测试连接
        </button>
        {saved && <span className="save-feedback ok">凭证已保存</span>}
      </div>

      {testResult && (
        <div className={`test-result ${testResult.ok ? "success" : "error"}`}>
          {testResult.ok ? "连接成功" : `连接失败: ${testResult.error}`}
        </div>
      )}
    </div>
  );
}
