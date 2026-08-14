import { useState } from "react";
import "./styles.css";

/**
 * 平台设置面板：凭证配置 + 连接测试。
 */
export default function TaskPlatformSettings() {
  const [platform, setPlatform] = useState("jira_cloud");
  const [token, setToken] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setTestResult(null);
    try {
      await window.aiCoder.setPlatformCredentials(platform, token.trim());
      setToken("");
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const result = await window.aiCoder.testPlatformConnection(platform);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="task-platform-settings">
      <h3>平台凭证配置</h3>

      <div className="settings-row">
        <label>平台</label>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="jira_cloud">Jira Cloud</option>
          <option value="jira_server">Jira Server</option>
          <option value="pingcode">PingCode</option>
          <option value="git_host">Git Host (GitHub PAT)</option>
        </select>
      </div>

      <div className="settings-row">
        <label>Token / API Key</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
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
      </div>

      {testResult && (
        <div className={`test-result ${testResult.ok ? "success" : "error"}`}>
          {testResult.ok ? "连接成功" : `连接失败: ${testResult.error}`}
        </div>
      )}
    </div>
  );
}
