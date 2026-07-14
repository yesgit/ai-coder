import { describe, expect, it } from "vitest";
import { evaluateBehaviorChecks } from "./stageOutputAssertions.js";
import type { ToolCallRecord, WorkflowStage } from "../../shared/types.js";

const PROJECT = "/proj";

function stageWithChecks(checks: WorkflowStage["hooks"] extends infer H ? H : never): WorkflowStage {
  return { id: "investigate", name: "Investigate", hooks: checks as WorkflowStage["hooks"] };
}

function bash(stageId: string, command: string, status: ToolCallRecord["status"] = "completed"): ToolCallRecord {
  return { id: `${stageId}-${command}-${Math.random()}`, stage_id: stageId, tool: "Bash", input: { command }, status, created_at: "t" };
}

function readCall(stageId: string, file_path: string, status: ToolCallRecord["status"] = "completed"): ToolCallRecord {
  return { id: `${stageId}-read-${file_path}`, stage_id: stageId, tool: "Read", input: { file_path }, status, created_at: "t" };
}

describe("evaluateBehaviorChecks", () => {
  it("透传：未声明 post_output_checks 返回空", () => {
    const out = evaluateBehaviorChecks(stageWithChecks(undefined), [], PROJECT);
    expect(out).toEqual([]);
  });

  describe("commands_run", () => {
    const s = stageWithChecks({
      post_output_checks: [
        { require: { commands_run: ["git log "] }, on_fail: "investigate 必须真跑过 git log" }
      ]
    });

    it("本阶段跑过含子串的 Bash 命令 → 通过", () => {
      const calls = [bash("investigate", "git log --oneline -5")];
      expect(evaluateBehaviorChecks(s, calls, PROJECT)).toEqual([]);
    });

    it("未跑过 → 失败，消息含 on_fail 与缺失命令", () => {
      const calls = [bash("investigate", "ls -la")];
      const out = evaluateBehaviorChecks(s, calls, PROJECT);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("investigate 必须真跑过 git log");
      expect(out[0].message).toContain("git log ");
    });

    it("只跑在别的 stage_id 的命令不算（调用方按 stage 切片）", () => {
      // 调用方应过滤本阶段；这里模拟"未过滤进来的他阶段调用"不应被本函数补救——
      // 事实上 hasShellRun 不看 stage_id，所以本函数信任调用方的切片。
      // 此测试固化契约：传入空切片 → 失败（即便全会话跑过，也由调用方负责切片）。
      expect(evaluateBehaviorChecks(s, [], PROJECT)).toHaveLength(1);
    });

    it("pending/cancelled 状态的命令不计入（只有 approved/completed 算真跑过）", () => {
      const calls = [bash("investigate", "git log --oneline", "pending_approval")];
      expect(evaluateBehaviorChecks(s, calls, PROJECT)).toHaveLength(1);
    });

    it("多条 commands_run 须全部满足", () => {
      const s2 = stageWithChecks({
        post_output_checks: [
          { require: { commands_run: ["git log ", "git diff"] }, on_fail: "两条都要跑" }
        ]
      });
      expect(evaluateBehaviorChecks(s2, [bash("investigate", "git log --oneline")], PROJECT)).toHaveLength(1);
      expect(
        evaluateBehaviorChecks(
          s2,
          [bash("investigate", "git log --oneline"), bash("investigate", "git diff HEAD~1")],
          PROJECT
        )
      ).toEqual([]);
    });
  });

  describe("successful_commands_run", () => {
    const s = stageWithChecks({
      post_output_checks: [
        { require: { successful_commands_run: ["npm test"] }, on_fail: "必须有真实成功的测试结果" }
      ]
    });

    it("只接受回传 exit_code=0 的命令结果", () => {
      const ok = { ...bash("investigate", "npm test"), exit_code: 0 };
      expect(evaluateBehaviorChecks(s, [ok], PROJECT)).toEqual([]);
    });

    it("未知或非零退出码不能冒充验证成功", () => {
      const unknown = bash("investigate", "npm test");
      const failed = { ...bash("investigate", "npm test"), exit_code: 1 };
      expect(evaluateBehaviorChecks(s, [unknown], PROJECT)).toHaveLength(1);
      expect(evaluateBehaviorChecks(s, [failed], PROJECT)).toHaveLength(1);
    });
  });

  describe("generic evidence counts", () => {
    it("requires real evidence calls and successful command results", () => {
      const s = stageWithChecks({
        post_output_checks: [{
          require: { evidence_calls_min: 2, successful_commands_min: 1 },
          on_fail: "需要真实证据"
        }]
      });
      const read = readCall("investigate", "src/a.ts");
      const failed = { ...bash("investigate", "npm test"), exit_code: 1 };
      expect(evaluateBehaviorChecks(s, [read, failed], PROJECT)).toHaveLength(1);
      const passed = { ...bash("investigate", "npm test"), exit_code: 0 };
      expect(evaluateBehaviorChecks(s, [read, passed], PROJECT)).toEqual([]);
    });

    it("does not count approved-only reads or Bash without exit_code=0 as evidence", () => {
      const s = stageWithChecks({
        post_output_checks: [{ require: { evidence_calls_min: 1 }, on_fail: "需要已完成证据" }]
      });
      expect(evaluateBehaviorChecks(s, [readCall("investigate", "src/a.ts", "approved")], PROJECT)).toHaveLength(1);
      expect(evaluateBehaviorChecks(s, [bash("investigate", "git status")], PROJECT)).toHaveLength(1);
      expect(evaluateBehaviorChecks(s, [{ ...bash("investigate", "git status"), exit_code: 0 }], PROJECT)).toEqual([]);
    });
  });

  describe("files_read", () => {
    const s = stageWithChecks({
      post_output_checks: [
        { require: { files_read: [{ target: "src/auth/login.ts", min: 2 }] }, on_fail: "必须读过 login.ts 两次" }
      ]
    });

    it("命中次数达标 → 通过", () => {
      const calls = [
        readCall("investigate", "src/auth/login.ts"),
        readCall("investigate", "/proj/src/auth/login.ts")
      ];
      expect(evaluateBehaviorChecks(s, calls, PROJECT)).toEqual([]);
    });

    it("命中次数不足 → 失败，消息标明目标与阈值", () => {
      const calls = [readCall("investigate", "src/auth/login.ts")];
      const out = evaluateBehaviorChecks(s, calls, PROJECT);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("src/auth/login.ts");
      expect(out[0].message).toContain("需2");
    });

    it("Grep pattern 含目标 basename 也算命中（防漏，与 pre_tool_use 同语义）", () => {
      const calls = [
        { id: "g1", stage_id: "investigate", tool: "Grep", input: { pattern: "login.ts" }, status: "completed" as const, created_at: "t" },
        { id: "g2", stage_id: "investigate", tool: "Grep", input: { pattern: "login.ts" }, status: "completed" as const, created_at: "t" }
      ];
      expect(evaluateBehaviorChecks(s, calls as ToolCallRecord[], PROJECT)).toEqual([]);
    });
  });

  it("commands_run + files_read 同一条 check 须都满足（AND 语义）", () => {
    const s = stageWithChecks({
      post_output_checks: [
        {
          require: {
            commands_run: ["git log "],
            files_read: [{ target: "src/auth/login.ts", min: 1 }]
          },
          on_fail: "既跑 git log 又读 login.ts"
        }
      ]
    });
    // 只跑命令没读文件 → 失败
    expect(evaluateBehaviorChecks(s, [bash("investigate", "git log --oneline")], PROJECT)).toHaveLength(1);
    // 只读文件没跑命令 → 失败
    expect(evaluateBehaviorChecks(s, [readCall("investigate", "src/auth/login.ts")], PROJECT)).toHaveLength(1);
    // 两者都做 → 通过
    expect(
      evaluateBehaviorChecks(
        s,
        [bash("investigate", "git log --oneline"), readCall("investigate", "src/auth/login.ts")],
        PROJECT
      )
    ).toEqual([]);
  });

  it("多条 post_output_checks 各自独立评估，任一失败即报", () => {
    const s = stageWithChecks({
      post_output_checks: [
        { require: { commands_run: ["git log "] }, on_fail: "缺 git log" },
        { require: { commands_run: ["git diff"] }, on_fail: "缺 git diff" }
      ]
    });
    const out = evaluateBehaviorChecks(s, [bash("investigate", "git log --oneline")], PROJECT);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("缺 git diff");
  });
});
