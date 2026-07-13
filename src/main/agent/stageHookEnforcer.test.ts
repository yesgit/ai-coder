import { describe, expect, it } from "vitest";
import { evaluateHook, checkCommandSafety } from "./stageHookEnforcer.js";
import type { HookDecision } from "./stageHookEnforcer.js";
import type { AgentSession, ToolCallRecord, WorkflowStage, HumanQuestion } from "../../shared/types.js";

function expectDenied(result: HookDecision): asserts result is { allow: false; message: string } {
  expect(result.allow).toBe(false);
}

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

describe("stageHookEnforcer.checkCommandSafety", () => {
  it("非 Bash 工具直接放行", () => {
    const result = checkCommandSafety("self_review", "Read", { file_path: "/tmp/a.ts" });
    expect(result.allow).toBe(true);
  });

  it("空命令放行", () => {
    const result = checkCommandSafety("self_review", "Bash", { command: "" });
    expect(result.allow).toBe(true);
  });

  it("sed -i 全局硬拒绝", () => {
    const result = checkCommandSafety("implement", "Bash", {
      command: "sed -i 's/old/new/' /path/to/file.js"
    });
    expectDenied(result);
    expect(result.message).toContain("sed -i");
  });

  it("sed --in-place 长格式也被拒绝", () => {
    const result = checkCommandSafety("implement", "Bash", {
      command: "sed --in-place 's/old/new/' file.js"
    });
    expectDenied(result);
    expect(result.message).toContain("sed");
  });

  it("sed -i 即使在 implement 阶段也拒绝", () => {
    const result = checkCommandSafety("implement", "Bash", {
      command: "sed -i '776s/.*/foo/' file.js"
    });
    expectDenied(result);
  });

  it("sed 不带 -i 放行（只预览）", () => {
    const result = checkCommandSafety("implement", "Bash", {
      command: "sed -n '775,780p' file.js"
    });
    expect(result.allow).toBe(true);
  });

  it("> 输出重定向在只读阶段 self_review 被拒绝", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "grep 'foo' file.js > /tmp/output.txt"
    });
    expectDenied(result);
    expect(result.message).toContain("输出重定向");
  });

  it("> 输出重定向在只读阶段 investigate 被拒绝", () => {
    const result = checkCommandSafety("investigate", "Bash", {
      command: "cat file.js > other.js"
    });
    expectDenied(result);
  });

  it(">> 追加重定向在只读阶段被拒绝", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "echo 'log' >> app.log"
    });
    expect(result.allow).toBe(false);
  });

  it("2>&1 在只读阶段放行（无害重定向）", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "npm test 2>&1 | head -50"
    });
    expect(result.allow).toBe(true);
  });

  it(">/dev/null 在只读阶段放行（无害重定向）", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "which node >/dev/null 2>&1"
    });
    expect(result.allow).toBe(true);
  });

  it(">> /dev/null 在只读阶段放行", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "npm ls >> /dev/null"
    });
    expect(result.allow).toBe(true);
  });

  it("引号内的 > 不误判", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: "grep '>' file.js"
    });
    expect(result.allow).toBe(true);
  });

  it("引号内的 >> 不误判", () => {
    const result = checkCommandSafety("self_review", "Bash", {
      command: 'echo "a >> b"'
    });
    expect(result.allow).toBe(true);
  });

  it("非只读阶段 implement 允许 > 重定向", () => {
    const result = checkCommandSafety("implement", "Bash", {
      command: "npm ls > deps.txt"
    });
    expect(result.allow).toBe(true);
  });

  it("聊天记录中 chatProvider.js 毁灭的真实命令应被拦截", () => {
    // 真实案例：self_review 阶段，grep 路径被截断，> 变成了输出重定向
    const result = checkCommandSafety("self_review", "Bash", {
      command: 'grep -n "SHOW_WAKE_UP_SCREEN_PAGE" /home/p> /home/user/projects/huaxiafortune/lib/views/AIAgentComponent/chatProvider.js | head -40'
    });
    expectDenied(result);
    expect(result.message).toContain("输出重定向");
  });

  it("decompose 阶段是只读阶段，> 重定向被拒绝", () => {
    const result = checkCommandSafety("decompose", "Bash", {
      command: "cat plan.md > backup.md"
    });
    expect(result.allow).toBe(false);
  });

  it("verify 阶段是只读阶段，> 重定向被拒绝", () => {
    const result = checkCommandSafety("verify", "Bash", {
      command: "git diff > changes.patch"
    });
    expect(result.allow).toBe(false);
  });
});
