import { describe, expect, test } from "bun:test";
import { PlanError } from "../src/plan";
import {
  expandMatrix,
  planWorkflow,
  plannedNoArtifactAccess,
  topoSort,
} from "../src/workflow-plan";

const customer = await Bun.file(`${import.meta.dir}/fixtures/customer-like.yml`).text();
const readFile = (): undefined => undefined;
const push = { name: "push", ref: "refs/heads/main" } as const;
const pr = {
  name: "pull_request",
  baseRef: "main",
  ref: "refs/pull/1/merge",
  action: "opened",
} as const;

describe("planWorkflow on a customer-style ci.yml", () => {
  const plan = planWorkflow(customer, push, { readFile });
  const job = (id: string) => plan.jobs.find((j) => j.id === id);

  test("trigger, name, env and concurrency", () => {
    expect(plan.trigger.matched).toBe(true);
    expect(plan.name).toBe("CI");
    expect(plan.env).toEqual({ NO_TELEMETRY: "1" });
    expect(plan.concurrency).toEqual({ group: "ci--refs/heads/main", cancelInProgress: true });
  });

  test("jobs are in dependency order with needs expanded to keys", () => {
    const order = plan.jobs.map((j) => j.id);
    for (const j of plan.jobs)
      for (const n of j.needs) expect(order.indexOf(n)).toBeLessThan(order.indexOf(j.id));
    expect(job("build")?.needsIds).toEqual(["changes", "tests-a", "engine-tests"]);
    expect(job("quality")?.needs).toEqual(["changes"]);
  });

  test("an if that reads event data is decided now; one that reads needs waits", () => {
    expect(job("changelog-guard")?.staticSkip?.reason).toContain("is false");
    expect(job("quality")?.staticSkip).toBeUndefined();
    expect(job("quality")?.ifExpr).toContain("needs.changes.outputs.code");
    const forPr = planWorkflow(customer, pr, { readFile });
    expect(forPr.jobs.find((j) => j.id === "changelog-guard")?.staticSkip).toBeUndefined();
  });

  test("outputs, continue-on-error and docker jobs", () => {
    expect(job("changes")?.outputs).toEqual({
      code: "${{ steps.classify.outputs.code }}",
      engine: "${{ steps.classify.outputs.engine }}",
    });
    expect(job("flaky")?.continueOnError).toBe(true);
    expect(job("images")?.unsupported).toContain("docker");
    expect(job("quality")?.unsupported).toBeUndefined();
  });

  test("an event the workflow does not trigger on is reported, not thrown", () => {
    const p = planWorkflow(customer, { name: "push", ref: "refs/heads/dev" }, { readFile });
    expect(p.trigger.matched).toBe(false);
  });
});

describe("matrix", () => {
  test("cartesian product, exclude, include (extends matches, appends non-matches)", () => {
    const combos = expandMatrix({
      os: ["linux", "mac"],
      node: [18, 20],
      exclude: [{ os: "mac", node: 18 }],
      include: [
        { os: "linux", extra: "yes" },
        { os: "win", node: 22 },
      ],
    });
    expect(combos).toEqual([
      { os: "linux", node: 18, extra: "yes" },
      { os: "linux", node: 20, extra: "yes" },
      { os: "mac", node: 20 },
      { os: "win", node: 22 },
    ]);
  });

  const mwf = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [18, 20]
    steps:
      - run: echo \${{ matrix.node }}
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;
  test("legs are separate jobs; dependents wait for every leg", () => {
    const p = planWorkflow(mwf, push, { readFile });
    expect(p.jobs.map((j) => j.key)).toEqual(["test[0]", "test[1]", "after"]);
    expect(p.jobs[0]).toMatchObject({
      matrix: { node: 18 },
      failFast: false,
      maxParallel: 2,
      name: "test (18)",
    });
    expect(p.jobs[2]?.needs).toEqual(["test[0]", "test[1]"]);
  });

  test("a matrix built from an expression is a placeholder, expanded when its needs finish", () => {
    const p = planWorkflow(
      `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix: \${{ fromJSON(needs.x.outputs.m) }}
    steps: []
`,
      push,
      { readFile },
    );
    const a = p.jobs.find((j) => j.id === "a");
    expect(a?.unsupported).toBeUndefined();
    expect(a?.key).toBe("a");
    expect(a?.dynamicMatrix?.matrix).toBe("${{ fromJSON(needs.x.outputs.m) }}");
  });
});

describe("graph errors and unsupported jobs", () => {
  test("unknown need and cycles", () => {
    const unknown = `on: push\njobs:\n  a:\n    needs: nope\n    runs-on: ubuntu-latest\n    steps: []\n`;
    expect(() => planWorkflow(unknown, push, { readFile })).toThrow(PlanError);
    const cycle = `on: push\njobs:\n  a:\n    needs: b\n    runs-on: ubuntu-latest\n    steps: []\n  b:\n    needs: a\n    runs-on: ubuntu-latest\n    steps: []\n`;
    expect(() => planWorkflow(cycle, push, { readFile })).toThrow(/cycle/);
    expect(() => topoSort([])).not.toThrow();
  });

  test.each([
    ["steps:\n      - uses: docker://alpine", "docker://"],
    ["steps:\n      - uses: docker/build-push-action@v6", "docker daemon"],
  ])("docker-requiring job: %s", (body, reason) => {
    const p = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    ${body}\n`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.unsupported).toContain(reason);
  });

  test.each([
    ["container: node:22\n    steps: []", "uses container:"],
    ["services:\n      db:\n        image: postgres\n    steps: []", "uses services:"],
  ])("services and container are routed, not refused: %s", (body, reason) => {
    const p = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    ${body}\n`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.needsDocker).toBe(reason);
    expect(p.jobs[0]?.unsupported).toBeUndefined();
  });

  test.each([
    ['options: --health-cmd "x ${{ env.A }}"', "options cannot use an expression"],
    ["ports:\n          - 5432:5432\n          - 5432:5433", "services:"],
  ])("services the split would refuse are unsupported in the plan: %s", (extra, reason) => {
    const p = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres\n        ${extra}\n    steps: []\n`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.unsupported).toContain(reason);
    expect(p.jobs[0]?.needsDocker).toBeUndefined();
  });

  test("services with a docker command in a step stays unsupported (container mode gives no socket)", () => {
    const p = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres\n    steps:\n      - run: docker ps\n`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.unsupported).toContain("docker command");
    expect(p.jobs[0]?.needsDocker).toBeUndefined();
  });

  test("non-Linux and a local docker action", () => {
    const win = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: windows-latest\n    steps: []\n`,
      push,
      { readFile },
    );
    expect(win.jobs[0]?.unsupported).toContain("Windows runner");
    const files: Record<string, string> = {
      ".github/actions/d/action.yml": "runs:\n  using: docker\n  image: Dockerfile\n",
    };
    const local = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/d\n`,
      push,
      { readFile: (f) => files[f] },
    );
    expect(local.jobs[0]?.unsupported).toContain("docker action");
  });
});

describe("local actions outside the repository", () => {
  test("a job whose local action path leaves the repo is unsupported, and nothing is read for it", () => {
    const reads: string[] = [];
    const wp = planWorkflow(
      "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./../../etc/x\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/ok\n",
      { name: "push", ref: "refs/heads/main" },
      { readFile: (p) => (reads.push(p), undefined) },
    );
    expect(wp.jobs.find((j) => j.id === "a")?.unsupported).toContain("outside the repository");
    expect(wp.jobs.find((j) => j.id === "b")?.unsupported).toBeUndefined();
    expect(reads.every((p) => p.startsWith(".github/actions/ok/"))).toBe(true);
  });
});

describe("job environment", () => {
  const wf = (env: string) => `
name: Release
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    ${env}
    steps:
      - run: echo deploy
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const plan = (env: string) =>
    planWorkflow(wf(env), push, { readFile }).jobs.find((j) => j.id === "deploy")!;

  test("a literal name, or the name of a mapping, is recorded", () => {
    expect(plan("environment: production").environment).toBe("production");
    expect(plan("environment:\n      name: release\n      url: https://x").environment).toBe(
      "release",
    );
    expect(
      planWorkflow(wf("environment: production"), push, { readFile }).jobs.find(
        (j) => j.id === "plain",
      )?.environment,
    ).toBeUndefined();
  });

  test("an environment built from an expression cannot be gated, so the job is refused", () => {
    const j = plan("environment: ${{ github.ref_name }}");
    expect(j.environment).toBeUndefined();
    expect(j.unsupported).toContain("environment");
  });
});

describe("the id-token flag on a planned job", () => {
  const plan = (head: string, jobPerm: string) =>
    planWorkflow(
      `name: t\non: push\n${head}jobs:\n  a:\n    runs-on: ubuntu-latest\n${jobPerm}    steps:\n      - run: echo hi\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
      push,
      { readFile },
    ).jobs;
  const flag = (jobs: ReturnType<typeof plan>, id: string) =>
    jobs.find((j) => j.id === id)!.idToken;

  test("set only for a job that asked, with the job block replacing the workflow's", () => {
    // Nothing asked: not set at all, so a stored plan stays as small as before.
    expect(flag(plan("", ""), "a")).toBeUndefined();
    // The workflow's block applies to a job with none of its own.
    const wfLevel = plan("permissions:\n  id-token: write\n", "");
    expect([flag(wfLevel, "a"), flag(wfLevel, "b")]).toEqual([true, true]);
    // A job's own block replaces it, in both directions.
    const off = plan(
      "permissions:\n  id-token: write\n",
      "    permissions:\n      contents: read\n",
    );
    expect([flag(off, "a"), flag(off, "b")]).toEqual([undefined, true]);
    const on = plan("", "    permissions:\n      id-token: write\n");
    expect([flag(on, "a"), flag(on, "b")]).toEqual([true, undefined]);
    // write-all counts; read-all and id-token: read do not.
    expect(flag(plan("permissions: write-all\n", ""), "a")).toBe(true);
    expect(flag(plan("permissions: read-all\n", ""), "a")).toBeUndefined();
    expect(flag(plan("permissions:\n  id-token: read\n", ""), "a")).toBeUndefined();
  });
});

describe("the artifact-access flag on a planned job", () => {
  const flag = (step: string) =>
    planWorkflow(
      `name: t\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${step}\n`,
      push,
      { readFile },
    ).jobs[0]!.artifactAccess;

  test("false only for a job with no artifact step and no local action", () => {
    expect(flag("run: echo hi")).toBe(false);
    expect(flag("uses: actions/checkout@v4")).toBe(false);
  });
  test("a job that uses an artifact action or a local action is left unflagged", () => {
    expect(flag("uses: actions/upload-artifact@v4")).toBeUndefined();
    expect(flag("uses: actions/download-artifact@v4")).toBeUndefined();
    expect(flag("uses: ./.github/actions/x")).toBeUndefined();
  });
  test("a remote action outside the known-safe list keeps the grant", () => {
    expect(flag("uses: actions/upload-pages-artifact@v3")).toBeUndefined();
    expect(flag("uses: actions/deploy-pages@v4")).toBeUndefined();
    expect(flag("uses: someorg/upload-wrapper@v1")).toBeUndefined();
    expect(flag("uses: actions/setup-node@v4")).toBe(false);
    expect(flag("uses: actions/cache/restore@v4")).toBe(false);
  });
  test("only an explicit false rules artifacts out", () => {
    expect(plannedNoArtifactAccess(JSON.stringify({ artifactAccess: false }))).toBe(true);
    expect(plannedNoArtifactAccess(JSON.stringify({ id: "x" }))).toBe(false);
    expect(plannedNoArtifactAccess(null)).toBe(false);
  });
});

describe("the artifact-upload flag on a planned job", () => {
  const jobs = (step: string) =>
    planWorkflow(
      `name: t\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${step}\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
      push,
      { readFile },
    ).jobs;
  const flags = (step: string) => jobs(step).map((j) => j.artifactUpload);

  test("set only for a job with an actions/upload-artifact step, at any ref", () => {
    const sha = "a".repeat(40);
    expect(flags(`uses: actions/upload-artifact@${sha} # v7`)).toEqual([true, undefined]);
    expect(flags("uses: actions/Upload-Artifact@v4")).toEqual([true, undefined]);
    expect(flags("uses: actions/upload-artifact/merge@v4")).toEqual([true, undefined]);
    // Other actions, including the download side, never set it.
    expect(flags("uses: actions/download-artifact@v8")).toEqual([undefined, undefined]);
    expect(flags("uses: other/upload-artifact@v4")).toEqual([undefined, undefined]);
    expect(flags("run: echo hi")).toEqual([undefined, undefined]);
  });
});

describe("run-name", () => {
  const wf = (rn: string): string =>
    `name: R\nrun-name: ${rn}\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
  const ev = { name: "workflow_dispatch", ref: "refs/heads/main" } as const;
  const opts = {
    readFile,
    github: { actor: "alice" },
    inputs: { app: "admin", dry: true, n: 3 },
  };

  test("evaluates github and inputs, typed values as strings", () => {
    const p = planWorkflow(
      wf("Deploy ${{ inputs.app }} by ${{ github.actor }} dry=${{ inputs.dry }} n=${{ inputs.n }}"),
      ev,
      opts,
    );
    expect(p.runName).toBe("Deploy admin by alice dry=true n=3");
    expect(p.runNameWarning).toBeUndefined();
  });

  test("another context or a bad expression falls back with a warning", () => {
    for (const rn of [
      "X ${{ secrets.A }}",
      "X ${{ env.A }}",
      "X ${{ success() }}",
      "X ${{ 1 + }}",
    ]) {
      const p = planWorkflow(wf(JSON.stringify(rn)), ev, opts);
      expect(p.runName).toBeUndefined();
      expect(p.runNameWarning).toContain("default title");
    }
  });

  test("no run-name: nothing is set", () => {
    const p = planWorkflow(wf("x").replace("run-name: x\n", ""), ev, opts);
    expect(p.runName).toBeUndefined();
    expect(p.runNameWarning).toBeUndefined();
  });
});
