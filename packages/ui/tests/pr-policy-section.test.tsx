import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseAuthors, PrPolicyPanel } from "../src/features/runs/pr-policy-section";

const render = (canEdit: boolean, isOwner: boolean, ingestEnabled = true) =>
  renderToStaticMarkup(
    <PrPolicyPanel
      current={{ prMode: "allowlist", authors: ["octocat", "app[bot]"], ingestEnabled }}
      canEdit={canEdit}
      isOwner={isOwner}
      busy={false}
      error={null}
      onSave={() => {}}
    />,
  );

describe("project pull request policy control", () => {
  test("an owner gets the form with the bot login in the list", () => {
    const html = render(true, true);
    expect(html).toContain("Save");
    expect(html).toContain("app[bot]");
    expect(html).not.toContain("an owner widens it");
  });
  test("an admin gets the form and is told only an owner widens", () => {
    const html = render(true, false);
    expect(html).toContain("Save");
    expect(html).toContain("an owner widens it");
  });
  test("a viewer sees the list and no form", () => {
    const html = render(false, false);
    expect(html).not.toContain("Save");
    expect(html).toContain("octocat, app[bot]");
  });
  test("without ingest there is nothing to edit", () => {
    expect(render(false, false, false)).toContain("Ingest is not turned on");
  });
  test("authors parse from lines or commas", () => {
    expect(parseAuthors("a, b[bot]\n c\n")).toEqual(["a", "b[bot]", "c"]);
  });
});
