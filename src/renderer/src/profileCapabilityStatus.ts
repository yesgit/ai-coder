import type { AgentSession } from "../../shared/types.js";

export type ProfileCapabilityStatus = "not_started" | "running" | "completed" | "failed";

function normalizedSkillId(value: string): string {
  return value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
}

export function getProfileSkillStatus(
  session: AgentSession | null | undefined,
  skillId: string
): ProfileCapabilityStatus {
  if (!session) return "not_started";
  const expected = normalizedSkillId(skillId);
  const loadedByHost = (session.progress_events ?? []).some((event) =>
    event.message.startsWith("宿主强制加载 Skill：")
    && normalizedSkillId(event.message.slice("宿主强制加载 Skill：".length).trim()) === expected
  );
  const loadedByTool = session.messages.some((message) =>
    message.kind === "skill_usage"
    && normalizedSkillId(message.content.replace(/`/g, "").trim()).includes(expected)
  );
  return loadedByHost || loadedByTool ? "completed" : "not_started";
}

export function getProfileAgentStatus(
  session: AgentSession | null | undefined,
  agentName: string
): ProfileCapabilityStatus {
  if (!session) return "not_started";
  const calls = session.tool_calls.filter((toolCall) => {
    if (toolCall.tool !== "Task" || typeof toolCall.input !== "object" || toolCall.input === null) {
      return false;
    }
    return (toolCall.input as Record<string, unknown>).subagent_type === agentName;
  });
  const latest = [...calls].reverse().find((toolCall) => toolCall.status !== "skipped");
  if (!latest) return "not_started";
  if (latest.status === "completed") return "completed";
  if (latest.status === "failed" || latest.status === "blocked" || latest.status === "denied" || latest.status === "cancelled") return "failed";
  return "running";
}
