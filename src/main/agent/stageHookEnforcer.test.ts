import { describe, expect, it } from "vitest";
import { evaluateHook } from "./stageHookEnforcer.js";
import type { AgentSession, ToolCallRecord, WorkflowStage, HumanQuestion } from "../../shared/types.js";

function makeStage(hooks?: WorkflowStage["hooks"]): WorkflowStage {
  return {
    id: "implement",
    name: "Implement",
    allowed_tools: ["read_file", "edit_file", "shell"],
    hooks
  };
}

function makeSession(tool_calls: ToolCallRecord[] = [], pending: HumanQuestion[] = []): AgentSession {
  return {
    id: "s1",
    project_path: "/tmp/proj",
    workflow_id: "wf",
    task_prompt: "",
    status: "running",
    current_stage: "implement",
    messages: [],
    tool_calls,
    file_changes: [],
    approvals: [],
    pending_human_questions: pending,
    created_at: "",
    updated_at: ""
  };
}

function readCall(file_path: string, opts: { stage_id?: string; tool?: string } = {}): ToolCallRecord {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    stage_id: opts.stage_id ?? "implement",
    tool: opts.tool ?? "Read",
    input: { file_path },
    status: "approved",
    created_at: ""
  };
}

function shellCall(command: string): ToolCallRecord {
  return {
    id: `b-${Math.random().toString(36).slice(2)}`,
    stage_id: "implement",
    tool: "Bash",
    input: { command },
    status: "completed",
    created_at: ""
  };
}

describe("stageHookEnforcer.evaluateHook", () => {
  it("透传：未声明 hooks 直接放行", () => {
    const stage = makeStage();
    const decision = evaluateHook(stage, makeSession(), "Edit", { file_path: "/tmp/proj/src/a.ts" });
    expect(decision.allow).toBe(true);
  });

  it("透传：声明的规则未匹配当前工具时放行", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Bash" },
          require: { shell_must_have_run: ["git log "] },
          on_fail: "需要先 git log"
        }
      ]
    });
    const decision = evaluateHook(stage, makeSession(), "Edit", { file_path: "/tmp/proj/src/a.ts" });
    expect(decision.allow).toBe(true);
  });

  it("same_file_reads_min: 同文件未读够 → 拦截", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: ["Edit", "Write"] },
          require: { same_file_reads_min: 3 },
          on_fail: "请先充分了解上下文。"
        }
      ]
    });
    const session = makeSession([readCall("/tmp/proj/src/a.ts"), readCall("/tmp/proj/src/a.ts")]);
    const decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/src/a.ts" });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.message).toContain("请先充分了解上下文");
  });

  it("same_file_reads_min: 读够 3 次后放行（Read 与 Grep 都算）", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Edit" },
          require: { same_file_reads_min: 3 },
          on_fail: "x"
        }
      ]
    });
    const session = makeSession([
      readCall("/tmp/proj/src/a.ts"),
      readCall("/tmp/proj/src/a.ts", { tool: "Grep" }),
      readCall("src/a.ts") // 路径表达不同，归一化后等价
    ]);
    const decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/src/a.ts" });
    expect(decision.allow).toBe(true);
  });

  it("same_file_reads_min: 别的文件读再多也不顶用", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Edit" },
          require: { same_file_reads_min: 3 },
          on_fail: "x"
        }
      ]
    });
    const session = makeSession([
      readCall("/tmp/proj/src/b.ts"),
      readCall("/tmp/proj/src/b.ts"),
      readCall("/tmp/proj/src/c.ts")
    ]);
    const decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/src/a.ts" });
    expect(decision.allow).toBe(false);
  });

  it("same_file_reads_min: 同名不同目录不互通（src/utils/a.ts vs lib/utils/a.ts）", () => {
    // P2 回归：旧实现只比对末 2 段，会把 src/utils/a.ts 与 lib/utils/a.ts 当同一文件。
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Edit" },
          require: { same_file_reads_min: 1 },
          on_fail: "x"
        }
      ]
    });
    const session = makeSession([
      readCall("/tmp/proj/lib/utils/a.ts"),
      readCall("/tmp/proj/lib/utils/a.ts"),
      readCall("/tmp/proj/lib/utils/a.ts")
    ]);
    const decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/src/utils/a.ts" });
    expect(decision.allow).toBe(false);
  });

  it("shell_must_have_run: 必须命中子串才放行", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Edit" },
          require: { shell_must_have_run: ["git log "] },
          on_fail: "请先 git log"
        }
      ]
    });
    // 没跑过 git log → 拦截
    let session = makeSession([shellCall("git status")]);
    let decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/a.ts" });
    expect(decision.allow).toBe(false);
    // 跑过了 → 放行
    session = makeSession([shellCall("git log -- src/a.ts")]);
    decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/a.ts" });
    expect(decision.allow).toBe(true);
  });

  it("command_contains: 仅在危险命令上触发 ask_human_consent", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Bash", command_contains: ["rm ", "git reset"] },
          require: { ask_human_consent: true },
          on_fail: "不可逆操作必须先经用户确认"
        }
      ]
    });
    // 安全命令直接放行
    let decision = evaluateHook(stage, makeSession(), "Bash", { command: "ls -la" });
    expect(decision.allow).toBe(true);
    // 危险命令 + 未 ask_human → 拦截
    decision = evaluateHook(stage, makeSession(), "Bash", { command: "rm -rf build/" });
    expect(decision.allow).toBe(false);
    // 危险命令 + 本阶段已 ask_human → 放行
    const pending: HumanQuestion[] = [
      {
        id: "q1",
        stage_id: "implement",
        question: "可以删 build/ 吗？",
        question_type: "single",
        status: "pending",
        created_at: ""
      }
    ];
    decision = evaluateHook(stage, makeSession([], pending), "Bash", { command: "rm -rf build/" });
    expect(decision.allow).toBe(true);
  });

  it("仅其他阶段的 ask_human 不算（同阶段约束）", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Bash", command_contains: ["rm "] },
          require: { ask_human_consent: true },
          on_fail: "x"
        }
      ]
    });
    const pending: HumanQuestion[] = [
      {
        id: "q1",
        stage_id: "design", // 不是 implement
        question: "?",
        question_type: "text",
        status: "answered",
        created_at: ""
      }
    ];
    const decision = evaluateHook(stage, makeSession([], pending), "Bash", { command: "rm -rf dist/" });
    expect(decision.allow).toBe(false);
  });

  it("denied 状态的工具调用不计入历史", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Edit" },
          require: { same_file_reads_min: 1 },
          on_fail: "x"
        }
      ]
    });
    const session = makeSession([
      { ...readCall("/tmp/proj/a.ts"), status: "denied" },
      { ...readCall("/tmp/proj/a.ts"), status: "blocked" }
    ]);
    const decision = evaluateHook(stage, session, "Edit", { file_path: "/tmp/proj/a.ts" });
    expect(decision.allow).toBe(false);
  });

  it("MultiEdit 的 edits[].file_path 也能被识别", () => {
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: ["Edit", "MultiEdit"] },
          require: { same_file_reads_min: 1 },
          on_fail: "x"
        }
      ]
    });
    const session = makeSession([readCall("/tmp/proj/a.ts")]);
    const decision = evaluateHook(stage, session, "MultiEdit", {
      edits: [{ file_path: "/tmp/proj/a.ts", old_string: "x", new_string: "y" }]
    });
    expect(decision.allow).toBe(true);
  });

  it("规则只挂 Edit/MultiEdit 时，Write 新建文件不被该规则拦截", () => {
    // P0 回归：careful-coder.yaml 把 Write 从 same_file_reads_min 移除后，
    // "新建一个不存在的文件" 这种场景不该被卡死或被迫去刷形式 grep。
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: ["Edit", "MultiEdit"] },
          require: { same_file_reads_min: 3 },
          on_fail: "x"
        }
      ]
    });
    const decision = evaluateHook(stage, makeSession(), "Write", {
      file_path: "/tmp/proj/src/brand-new.ts",
      content: "export const x = 1;"
    });
    expect(decision.allow).toBe(true);
  });

  it("command_contains 仅在 Bash 工具上触发；其他工具即使 input.command 看似含子串也透传", () => {
    // P2 回归：when.tool 缺省时也不该把 Edit/Read 当作 Bash 命中（防御性）。
    const stage = makeStage({
      pre_tool_use: [
        {
          when: { tool: "Bash", command_contains: ["rm "] },
          require: { ask_human_consent: true },
          on_fail: "x"
        }
      ]
    });
    const decision = evaluateHook(stage, makeSession(), "Edit", {
      file_path: "/tmp/proj/a.ts",
      old_string: "rm -rf",
      new_string: "echo"
    });
    expect(decision.allow).toBe(true);
  });
});
