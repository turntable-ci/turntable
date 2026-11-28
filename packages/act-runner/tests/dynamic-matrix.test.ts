// #797: strategy.matrix built from needs outputs. Matrix shapes follow GitHub's documented rules
// for include and exclude, and its 256 combination limit.
import { describe, expect, test } from "bun:test";
import {
  expandDynamicMatrix,
  expandMatrix,
  matrixCombos,
  MAX_MATRIX_COMBINATIONS,
  planWorkflow,
  type PlannedJob,
} from "../src";

const push = { name: "push", ref: "refs/heads/main" };

describe("matrix include and exclude follow GitHub", () => {
  const table: { name: string; matrix: unknown; want: Record<string, unknown>[] }[] = [
    {
      name: "plain product",
      matrix: { os: ["a", "b"], node: [1, 2] },
      want: [
        { os: "a", node: 1 },
        { os: "a", node: 2 },
        { os: "b", node: 1 },
        { os: "b", node: 2 },
      ],
    },
    {
      name: "exclude removes every combination it is a subset of",
      matrix: { os: ["a", "b"], node: [1, 2], exclude: [{ os: "a" }] },
      want: [
        { os: "b", node: 1 },
        { os: "b", node: 2 },
      ],
    },
    {
      name: "exclude with two keys removes one combination",
      matrix: { os: ["a", "b"], node: [1, 2], exclude: [{ os: "b", node: 2 }] },
      want: [
        { os: "a", node: 1 },
        { os: "a", node: 2 },
        { os: "b", node: 1 },
      ],
    },
    {
      name: "include adds an extra key to matching combinations",
      matrix: { os: ["a", "b"], include: [{ os: "a", extra: "x" }] },
      want: [{ os: "a", extra: "x" }, { os: "b" }],
    },
    {
      name: "include that matches nothing is its own combination",
      matrix: { os: ["a", "b"], include: [{ os: "c" }] },
      want: [{ os: "a" }, { os: "b" }, { os: "c" }],
    },
    {
      name: "include never overwrites an axis value, so it becomes a new combination",
      matrix: { os: ["a"], node: [1], include: [{ os: "a", node: 2 }] },
      want: [
        { os: "a", node: 1 },
        { os: "a", node: 2 },
      ],
    },
    {
      name: "include with no axis key is added to every combination",
      matrix: { os: ["a", "b"], include: [{ color: "green" }] },
      want: [
        { os: "a", color: "green" },
        { os: "b", color: "green" },
      ],
    },
    {
      // The worked example of GitHub's docs on expanding or adding matrix configurations.
      name: "GitHub docs: fruit and animal",
      matrix: {
        fruit: ["apple", "pear"],
        animal: ["cat", "dog"],
        include: [
          { color: "green" },
          { color: "pink", animal: "cat" },
          { fruit: "apple", shape: "circle" },
          { fruit: "banana" },
          { fruit: "banana", animal: "cat" },
        ],
      },
      want: [
        { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
        { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
        { fruit: "pear", animal: "cat", color: "pink" },
        { fruit: "pear", animal: "dog", color: "green" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ],
    },
    {
      name: "only include: each entry is a combination",
      matrix: { include: [{ a: 1 }, { a: 2, b: 3 }] },
      want: [{ a: 1 }, { a: 2, b: 3 }],
    },
    {
      name: "an include-created combination is not matched by a later include",
      matrix: { os: ["a"], include: [{ os: "b" }, { os: "b", extra: 1 }] },
      want: [{ os: "a" }, { os: "b" }, { os: "b", extra: 1 }],
    },
    {
      name: "exclude is applied before include",
      matrix: { os: ["a", "b"], exclude: [{ os: "a" }], include: [{ os: "a", extra: 1 }] },
      want: [{ os: "b" }, { os: "a", extra: 1 }],
    },
    {
      name: "object values compare deeply",
      matrix: { cfg: [{ k: 1 }, { k: 2 }], exclude: [{ cfg: { k: 1 } }] },
      want: [{ cfg: { k: 2 } }],
    },
    {
      name: "an empty axis leaves no combination",
      matrix: { os: [] },
      want: [],
    },
  ];
  for (const t of table) {
    test(t.name, () => {
      expect(matrixCombos(t.matrix)).toEqual(t.want as never);
    });
  }

  test("a static matrix over 256 combinations is a plan error, and 256 is fine", () => {
    const axis = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(expandMatrix({ a: axis(16), b: axis(16) })).toHaveLength(256);
    expect(() => expandMatrix({ a: axis(16), b: axis(17) })).toThrow("limit is 256");
    expect(() => expandMatrix({ a: [] })).toThrow("no jobs");
  });
});

const placeholder = (matrix: string, extra = ""): PlannedJob => {
  const yaml = `on: push
jobs:
  x:
    runs-on: ubuntu-latest
    outputs:
      m: \${{ steps.s.outputs.m }}
    steps: []
  build:
    needs: x
    runs-on: ${"${{ matrix.os }}"}
    ${extra}
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix: ${matrix}
    steps: []
`;
  return planWorkflow(yaml, push, { readFile: () => undefined }).jobs.find(
    (j) => j.id === "build",
  ) as PlannedJob;
};

const needs = (m: string) => ({ x: { result: "success", outputs: { m } } });

describe("expanding a dynamic matrix", () => {
  const whole = "${{ fromJSON(needs.x.outputs.m) }}";

  test("the planner keeps one placeholder, not unsupported, with no runs-on guess", () => {
    const p = placeholder(whole);
    expect(p.key).toBe("build");
    expect(p.unsupported).toBeUndefined();
    expect(p.runsOn).toBeUndefined();
    expect(p.maxParallel).toBe(2);
    expect(p.failFast).toBe(false);
  });

  test("legs are keyed id[n], named like GitHub, and keep the job's settings", () => {
    const out = expandDynamicMatrix(
      placeholder(whole),
      {},
      needs(JSON.stringify({ os: ["ubuntu-latest", "ubuntu-22.04"], node: [18, 20] })),
    );
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs.map((l) => l.key)).toEqual(["build[0]", "build[1]", "build[2]", "build[3]"]);
    expect(out.legs.map((l) => l.name)).toEqual([
      "build (ubuntu-latest, 18)",
      "build (ubuntu-latest, 20)",
      "build (ubuntu-22.04, 18)",
      "build (ubuntu-22.04, 20)",
    ]);
    expect(out.legs[2]?.matrix).toEqual({ os: "ubuntu-22.04", node: 18 });
    expect(out.legs[2]?.runsOn).toEqual(["ubuntu-22.04"]);
    expect(out.legs.every((l) => l.maxParallel === 2 && !l.failFast && !l.dynamicMatrix)).toBe(
      true,
    );
    expect(out.legs.every((l) => l.needsIds[0] === "x" && l.id === "build")).toBe(true);
  });

  test("include and exclude inside the JSON", () => {
    const out = expandDynamicMatrix(
      placeholder(whole),
      {},
      needs(
        JSON.stringify({
          os: ["a", "b"],
          exclude: [{ os: "a" }],
          include: [{ os: "c", pkg: "web" }],
        }),
      ),
    );
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs.map((l) => l.matrix)).toEqual([{ os: "b" }, { os: "c", pkg: "web" }]);
  });

  test("the common monorepo shape: an include list of packages", () => {
    const out = expandDynamicMatrix(
      placeholder(whole),
      {},
      needs(
        JSON.stringify({
          include: [
            { os: "ubuntu-latest", package: "api" },
            { os: "ubuntu-latest", package: "web" },
          ],
        }),
      ),
    );
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs.map((l) => l.name)).toEqual([
      "build (ubuntu-latest, api)",
      "build (ubuntu-latest, web)",
    ]);
  });

  test("an axis or include built from an expression, next to a literal axis", () => {
    const p = placeholder(`
        os: [ubuntu-latest]
        pkg: \${{ fromJSON(needs.x.outputs.m) }}`);
    const out = expandDynamicMatrix(p, {}, needs('["a","b"]'));
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs.map((l) => l.matrix)).toEqual([
      { os: "ubuntu-latest", pkg: "a" },
      { os: "ubuntu-latest", pkg: "b" },
    ]);
  });

  test("an include list expression", () => {
    const p = placeholder(`
        os: [ubuntu-latest]
        include: \${{ fromJSON(needs.x.outputs.m) }}`);
    const out = expandDynamicMatrix(p, {}, needs('[{"os":"ubuntu-latest","k":1}]'));
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs.map((l) => l.matrix)).toEqual([{ os: "ubuntu-latest", k: 1 }]);
  });

  test("an empty matrix skips the job", () => {
    for (const m of ["{}", '{"include":[]}', '{"os":[]}']) {
      const out = expandDynamicMatrix(placeholder(whole), {}, needs(m));
      expect(out.kind).toBe("empty");
    }
  });

  test("invalid JSON fails with a clear message", () => {
    const out = expandDynamicMatrix(placeholder(whole), {}, needs("{not json"));
    expect(out).toEqual({
      kind: "error",
      message: "strategy.matrix is not valid: fromJSON() got invalid JSON",
    });
  });

  test("an output that is missing or not an object fails", () => {
    expect(
      expandDynamicMatrix(placeholder(whole), {}, { x: { result: "success", outputs: {} } }),
    ).toMatchObject({ kind: "error" });
    const list = expandDynamicMatrix(placeholder(whole), {}, needs("[1,2]"));
    expect(list).toMatchObject({ kind: "error" });
    expect((list as { message: string }).message).toContain("did not evaluate to an object");
    expect(expandDynamicMatrix(placeholder(whole), {}, needs('{"os":"a"}'))).toMatchObject({
      kind: "error",
    });
  });

  test("limit: 256 combinations expand, 257 fail", () => {
    const include = (n: number) => ({
      include: Array.from({ length: n }, (_, i) => ({ os: "ubuntu-latest", i })),
    });
    const ok = expandDynamicMatrix(placeholder(whole), {}, needs(JSON.stringify(include(256))));
    expect(ok.kind === "legs" && ok.legs.length).toBe(MAX_MATRIX_COMBINATIONS);
    const bad = expandDynamicMatrix(placeholder(whole), {}, needs(JSON.stringify(include(257))));
    expect(bad).toEqual({
      kind: "error",
      message: "matrix expands to 257 jobs; the limit is 256",
    });
  });

  test("a value holding an expression is refused, never evaluated by act later", () => {
    for (const m of [
      { include: [{ pkg: "${{ toJSON(secrets) }}" }] },
      { pkg: [["x", "a${{ secrets.T }}"]] },
      { "k${{ x }}": ["a"] },
    ]) {
      const out = expandDynamicMatrix(placeholder(whole), {}, needs(JSON.stringify(m)));
      expect(out).toMatchObject({ kind: "error" });
      expect((out as { message: string }).message).toContain("never evaluated");
    }
  });

  test("a huge include, exclude or product fails fast", () => {
    const axis = (n: number) => Array.from({ length: n }, (_, i) => i);
    const big = {
      a: axis(128),
      b: axis(128),
      exclude: Array.from({ length: 30000 }, (_, i) => ({ a: i })),
    };
    const t0 = performance.now();
    expect(expandDynamicMatrix(placeholder(whole), {}, needs(JSON.stringify(big)))).toMatchObject({
      kind: "error",
    });
    expect(
      expandDynamicMatrix(
        placeholder(whole),
        {},
        needs(JSON.stringify({ a: axis(40), b: axis(40) })),
      ),
    ).toMatchObject({ kind: "error" });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a leg whose runs-on names another OS is unsupported, others are not", () => {
    const out = expandDynamicMatrix(
      placeholder(whole),
      {},
      needs(JSON.stringify({ os: ["ubuntu-latest", "macos-14"] })),
    );
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs[0]?.unsupported).toBeUndefined();
    expect(out.legs[1]?.unsupported).toContain("macOS");
  });

  test("a continue-on-error expression and a name read the leg's matrix", () => {
    const p = placeholder(
      `\${{ fromJSON(needs.x.outputs.m) }}`,
      "name: ${{ matrix.pkg }} tests\n    continue-on-error: ${{ matrix.exp }}",
    );
    const out = expandDynamicMatrix(
      p,
      {},
      needs(
        '{"os":["ubuntu-latest"],"pkg":["a"],"include":[{"os":"ubuntu-latest","pkg":"a","exp":true}]}',
      ),
    );
    if (out.kind !== "legs") throw new Error(out.kind);
    expect(out.legs[0]?.name).toBe("a tests");
    expect(out.legs[0]?.continueOnError).toBe(true);
  });

  test("the github, vars and inputs contexts are readable", () => {
    const p = placeholder("${{ fromJSON(vars.M) }}");
    const out = expandDynamicMatrix(p, { vars: { M: '{"os":["ubuntu-latest"]}' } }, {});
    expect(out.kind).toBe("legs");
  });
});
