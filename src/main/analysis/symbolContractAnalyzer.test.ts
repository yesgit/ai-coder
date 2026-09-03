import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeSymbolContract,
  resolveEnclosingCallableDefinition
} from "./symbolContractAnalyzer.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symbol-contract-"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx"
    },
    include: ["*.ts", "*.tsx"]
  }));
  await writeFile(path.join(root, "target.tsx"), `
export interface ActionProps {
  /** Text visible to the user. */
  label: string;
  /** Number of retries. */
  retries?: number;
  mode?: "safe" | "fast";
}

export function Action({ label, retries = 2, mode = "safe" }: ActionProps) {
  return <button data-mode={mode}>{label}:{retries}</button>;
}
`);
  await writeFile(path.join(root, "usage.tsx"), `
import { Action } from "./target.js";

export function ActionWrapper(label: string, enabled = true) {
  if (!enabled) return null;
  return Action({ label, mode: "fast" });
}

export function Screen({ ready, title }: { ready: boolean; title: string }) {
  return ready ? <Action label={title} /> : null;
}

export const registeredAction = Action;
`);
  return root;
}

describe("analyzeSymbolContract", () => {
  it("resolves a dispatcher branch to its named owner, including class-field arrows", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "routes.ts"), `
export function dispatch(page: string) {
  [page].forEach((candidate) => {
    if (candidate === "target") open(candidate);
  });
}

export class ScreenRoutes {
  openTarget = (enabled: boolean) => {
    if (enabled) navigator.push({ component: Target });
  };
}
`);

    expect(resolveEnclosingCallableDefinition(root, "routes.ts", 4)).toMatchObject({
      symbol: "dispatch",
      file: "routes.ts",
      line: 2
    });
    expect(resolveEnclosingCallableDefinition(root, "routes.ts", 10)).toMatchObject({
      symbol: "openTarget",
      file: "routes.ts",
      line: 9
    });
    expect(() => resolveEnclosingCallableDefinition(root, "../outside.ts", 1))
      .toThrow("目标文件必须位于项目目录内");
  });

  it("collects the target contract, all call combinations, guards, wrappers and indirect references", async () => {
    const root = await createFixture();
    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action",
      limit: 1
    });

    expect(result.target).toMatchObject({ symbol: "Action", file: "target.tsx" });
    expect(result.contract?.component_props).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "label", type: "string", required: true, meaning: "Text visible to the user." }),
      expect.objectContaining({ name: "retries", required: false, default_logic: "2" }),
      expect.objectContaining({ name: "mode", required: false, default_logic: "\"safe\"" })
    ]));
    expect(result.coverage.total_call_sites).toBe(2);
    expect(result.calls?.items).toHaveLength(1);
    expect(result.calls?.page.next_offset).toBe(1);
    expect(result.calls?.combinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "call", provided_parameters: ["label", "mode"], count: 1 }),
      expect.objectContaining({ kind: "jsx", provided_parameters: ["label"], count: 1 })
    ]));
    expect(result.wrappers?.items.map((item) => item.name)).toEqual(["ActionWrapper", "Screen"]);
    expect(result.wrappers?.items.find((item) => item.name === "ActionWrapper")?.target_calls[0].preconditions)
      .toContain("after guard: NOT (!enabled)");
    expect(result.references?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assigned", expression: "Action" })
    ]));

    const wrappersPage = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action",
      section: "wrappers",
      limit: 1
    });
    expect(wrappersPage.wrappers?.items).toHaveLength(1);
    expect(wrappersPage.wrappers?.page).toMatchObject({ total: 2, next_offset: 1 });

    const referencesPage = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action",
      section: "references",
      limit: 1
    });
    expect(referencesPage.references?.items).toHaveLength(1);
    expect(referencesPage.references?.page.total).toBeGreaterThanOrEqual(1);
  });

  it("rejects target files outside the project", async () => {
    const root = await createFixture();
    expect(() => analyzeSymbolContract({
      projectPath: root,
      targetFile: path.join(root, "../outside.ts"),
      symbol: "outside"
    })).toThrow("目标文件必须位于项目目录内");
  });

  it("falls back to syntax analysis when the project tsconfig is invalid", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "DefinitelyNotATypeScriptModuleKind"
      }
    }));

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action"
    });

    expect(result.coverage.analysis_mode).toBe("syntax-fallback");
    expect(result.coverage.configuration_warnings.length).toBeGreaterThan(0);
    expect(result.target).toMatchObject({ symbol: "Action", file: "target.tsx" });
    expect(result.coverage.total_call_sites).toBe(2);
  });

  it("reports every overload and class component prop contract", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "contracts.ts"), `
export function format(value: string): string;
export function format(value: number, radix: number): string;
export function format(value: string | number, radix = 10): string {
  return typeof value === "number" ? value.toString(radix) : value;
}

class Component<Props> {}
export interface PanelProps {
  /** Navigation object forwarded by the caller. */
  navigator: { push(route: string): void };
  /** Optional display title. */
  title?: string;
}
export class Panel extends Component<PanelProps> {}
`);

    const overloads = analyzeSymbolContract({
      projectPath: root,
      targetFile: "contracts.ts",
      symbol: "format",
      section: "contract"
    });
    expect(overloads.contract?.signatures).toHaveLength(2);
    expect(overloads.contract?.signatures.map((signature) =>
      signature.inputs.map((input) => `${input.name}:${input.type}`)
    )).toEqual(expect.arrayContaining([
      ["value:string"],
      ["value:number", "radix:number"]
    ]));

    const component = analyzeSymbolContract({
      projectPath: root,
      targetFile: "contracts.ts",
      symbol: "Panel",
      section: "contract"
    });
    expect(component.contract?.component_props).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "navigator",
        required: true,
        meaning: "Navigation object forwarded by the caller."
      }),
      expect.objectContaining({
        name: "title",
        required: false,
        meaning: "Optional display title."
      })
    ]));
    expect(component.contract?.inputs[0]).toMatchObject({
      name: "props",
      type: "PanelProps"
    });
  });

  it("keeps unrelated configured sources out of a symbol investigation program", async () => {
    const root = await createFixture();
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      writeFile(path.join(root, `unrelated-${index}.ts`), `
export function helper${index}(value: string) {
  return value;
}
`)
    )));

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action"
    });

    expect(result.coverage.files_scanned).toBe(2);
    expect(result.coverage.total_call_sites).toBe(2);
  });

  it("lifts a symbol carried through objects and aliases into a generic indirect invocation", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "indirect.ts"), `
import { Action } from "./target.js";

declare const executor: {
  run(value: unknown): void;
};

export function openAction(enabled: boolean, title: string, navigator: unknown) {
  if (!enabled) return;
  const descriptor = {
    destination: Action,
    params: { label: title, mode: "fast" },
    context: { navigator }
  };
  const alias = descriptor;
  executor.run(alias);
}
`);

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action"
    });

    const indirect = result.calls?.items.find((call) => call.kind === "indirect");
    expect(indirect).toMatchObject({
      enclosing_callable: "openAction",
      invocation: "executor.run(alias)",
      target_path: "destination"
    });
    expect(indirect?.payload_expression).toContain("params: { label: title, mode: \"fast\" }");
    expect(indirect?.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameter: "payload.destination", expression: "Action" }),
      expect.objectContaining({
        parameter: "payload.params",
        expression: "{ label: title, mode: \"fast\" }"
      }),
      expect.objectContaining({ parameter: "payload.context", expression: "{ navigator }" })
    ]));
    expect(indirect?.preconditions).toContain("after guard: NOT (!enabled)");
    expect(result.references?.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stored-as-property", expression: "Action" })
    ]));
  });

  it("collects outgoing calls and their control-flow preconditions from an entry callable", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "entry.ts"), `
declare function isAllowed(value: string): boolean;
declare function perform(value: string, options: { mode: string }): void;

export function enter(value: string) {
  if (!isAllowed(value)) return;
  perform(value, { mode: "safe" });
}
`);

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "entry.ts",
      symbol: "enter"
    });

    expect(result.effects?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        callee: "isAllowed",
        invocation: "isAllowed(value)"
      }),
      expect.objectContaining({
        callee: "perform",
        invocation: "perform(value, { mode: \"safe\" })",
        preconditions: ["after guard: NOT (!isAllowed(value))"]
      })
    ]));
    expect(result.coverage.total_outgoing_calls).toBe(2);

    const effectsPage = analyzeSymbolContract({
      projectPath: root,
      targetFile: "entry.ts",
      symbol: "enter",
      section: "effects",
      limit: 1
    });
    expect(effectsPage.effects?.items).toHaveLength(1);
    expect(effectsPage.effects?.page).toMatchObject({ total: 2, next_offset: 1 });
  });

  it("follows an exported payload alias into a consumer module without loading unrelated files", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "config.ts"), `
import { Action } from "./target.js";
export const actionDescriptor = {
  destination: Action,
  params: { label: "cross-module" }
};
`);
    await writeFile(path.join(root, "consumer.ts"), `
import { actionDescriptor } from "./config.js";
declare const executor: { run(value: unknown): void };
export function consume() {
  executor.run(actionDescriptor);
}
`);
    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      writeFile(path.join(root, `noise-${index}.ts`), `export const noise${index} = ${index};\n`)
    )));

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "target.tsx",
      symbol: "Action"
    });

    expect(result.calls?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "indirect",
        invocation: "executor.run(actionDescriptor)",
        target_path: "destination",
        payload_expression: expect.stringContaining("destination: Action")
      })
    ]));
    expect(result.coverage.files_scanned).toBeLessThan(10);
  });

  it("follows a component through a default-exported HOC into real navigation entries", async () => {
    const root = await createFixture();
    await writeFile(path.join(root, "connected.tsx"), `
declare function connect(mapper: unknown): (component: unknown) => unknown;
const mapState = (state: unknown) => state;

class Destination {}
export default connect(mapState)(Destination);
`);
    await writeFile(path.join(root, "connected-entry.ts"), `
import ConnectedDestination from "./connected.js";
declare const navigator: { push(route: unknown): void };

export function openDestination(ready: boolean, title: string) {
  if (!ready) return;
  navigator.push({
    component: ConnectedDestination,
    params: { title }
  });
}
`);

    const result = analyzeSymbolContract({
      projectPath: root,
      targetFile: "connected.tsx",
      symbol: "Destination"
    });

    expect(result.calls?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "indirect",
        enclosing_callable: "openDestination",
        invocation: expect.stringContaining("navigator.push"),
        target_path: "component",
        preconditions: ["after guard: NOT (!ready)"]
      })
    ]));
  });
});
