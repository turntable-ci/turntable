import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFixtureOnboarding } from "../src/api/fixture/onboarding";
import { ProjectVarsPanel, varNameProblem } from "../src/features/runs/project-vars-section";

const vars = [
  { name: "TURNTABLE_CI", value: "true", reserved: true },
  { name: "VITE_KEY", value: "pk_x", reserved: false },
];
const noop = () => {};
const html = (canEdit: boolean) =>
  renderToStaticMarkup(
    <ProjectVarsPanel
      vars={vars}
      canEdit={canEdit}
      busy={false}
      error={null}
      onSave={noop}
      onDelete={noop}
    />,
  );

describe("project variables", () => {
  test("an operator can add, edit and delete; the reserved one has no controls", () => {
    const h = html(true);
    expect(h).toContain("VITE_KEY");
    expect(h).toContain('aria-label="Edit VITE_KEY"');
    expect(h).toContain('aria-label="Delete VITE_KEY"');
    expect(h).toContain('aria-label="Variable name"');
    expect(h).toContain("Set by Turntable");
    expect(h).not.toContain('aria-label="Delete TURNTABLE_CI"');
  });
  test("a reader sees the list and no form", () => {
    const h = html(false);
    expect(h).toContain("VITE_KEY");
    expect(h).not.toContain("Variable name");
    expect(h).not.toContain("Delete VITE_KEY");
  });
  test("names are checked like the server does", () => {
    expect(varNameProblem("VITE_OK_1")).toBeNull();
    expect(varNameProblem("GITHUB_X")).not.toBeNull();
    expect(varNameProblem("1X")).not.toBeNull();
    expect(varNameProblem("a b")).not.toBeNull();
  });
  test("the fixture keeps TURNTABLE_CI and round-trips a variable", async () => {
    const api = createFixtureOnboarding();
    const args = { org: "acme", project: "web" };
    await api.setProjectVar({ ...args, name: "VITE_A", value: "1" });
    expect((await api.listProjectVars(args)).map((v) => v.name)).toEqual([
      "TURNTABLE_CI",
      "VITE_A",
    ]);
    await expect(
      api.setProjectVar({ ...args, name: "TURNTABLE_CI", value: "x" }),
    ).rejects.toThrow();
    await expect(api.deleteProjectVar({ ...args, name: "TURNTABLE_CI" })).rejects.toThrow();
    await api.deleteProjectVar({ ...args, name: "VITE_A" });
    expect((await api.listProjectVars(args)).length).toBe(1);
  });
});
