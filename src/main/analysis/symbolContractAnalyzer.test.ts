import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSymbolContract } from "./symbolContractAnalyzer.js";

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
});
