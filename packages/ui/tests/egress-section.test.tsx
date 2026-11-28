import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EgressPanel } from "../src/features/runs/egress-section";

const render = (current: "none" | "allowlist" | "open", canEdit: boolean) =>
  renderToStaticMarkup(
    <EgressPanel
      current={current}
      canEdit={canEdit}
      busy={false}
      error={null}
      warnings={[]}
      onTighten={() => {}}
    />,
  );

describe("project egress control", () => {
  test("an owner on open can tighten to allowlist or none, never widen", () => {
    const html = render("open", true);
    expect(html).toContain("Tighten to allowlist");
    expect(html).toContain("Tighten to none");
    expect(html).not.toContain("Tighten to open");
  });
  test("on allowlist only none is offered", () => {
    const html = render("allowlist", true);
    expect(html).toContain("Tighten to none");
    expect(html).not.toContain("Tighten to allowlist");
  });
  test("none offers nothing, and a non-owner sees no buttons", () => {
    expect(render("none", true)).not.toContain("Tighten to");
    expect(render("open", false)).not.toContain("Tighten to");
  });
});
