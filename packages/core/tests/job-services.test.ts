import { describe, expect, test } from "bun:test";
import type { ContainerJobs } from "../src/poll/onboarding-forge";
import { previewWorkflow } from "../src/poll/workflow-preview";
import { dockerRefusal, type SandboxSizes } from "../src/scheduler/sandbox-size";

// The preview of a job with `services:` (#796): runnable in container mode where the instance has
// a Docker-capable class on a provider that can host Docker, else the scheduler's own refusal.
const WF = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: x }
        ports: ["5432:5432"]
        options: --health-cmd pg_isready
    steps:
      - run: pg_isready -h localhost -p 5432
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;

const sizes = (): SandboxSizes =>
  ({
    classes: { dind: { docker: true } },
    labels: {},
    dockerClass: "dind",
  }) as unknown as SandboxSizes;

// The same rule main.ts hands the preview for a trusted run.
const capability =
  (cfg: SandboxSizes | undefined, provider: { dockerInSandbox?: boolean }): ContainerJobs =>
  (need) => {
    const reason = dockerRefusal(cfg, need, { untrusted: false, provider });
    return reason === undefined ? { runnable: true } : { runnable: false, reason };
  };

const jobs = (containerJobs?: ContainerJobs) => {
  const p = previewWorkflow(WF, {
    defaultBranch: "main",
    vars: { TURNTABLE_CI: "true" },
    ...(containerJobs ? { containerJobs } : {}),
  })!;
  return Object.fromEntries(p.jobs.map((j) => [j.job_id, j]));
};

describe("preview of a job with services", () => {
  test("runnable in container mode on a Docker-capable class (Daytona declares dockerInSandbox)", () => {
    const by = jobs(capability(sizes(), { dockerInSandbox: true }));
    expect(by.test).toMatchObject({ verdict: "run", mode: "container" });
    expect(by.test?.reason).toBeUndefined();
    expect(by.plain).toMatchObject({ verdict: "run", mode: "host" });
  });

  test("no Docker-capable class: fails with the scheduler's reason and the fix", () => {
    const by = jobs(capability(undefined, { dockerInSandbox: true }));
    expect(by.test?.verdict).toBe("fail");
    expect(by.test?.reason).toContain("uses services:");
    expect(by.test?.reason).toContain("no Docker-capable size class");
    expect(by.test?.fix).toContain("Docker-capable size class");
    expect(by.test?.mode).toBeUndefined();
  });

  test("a provider that cannot host Docker: fails naming that", () => {
    const by = jobs(capability(sizes(), {}));
    expect(by.test?.verdict).toBe("fail");
    expect(by.test?.reason).toContain("cannot run Docker inside a sandbox");
  });

  test("a server with no worker to ask says it cannot tell", () => {
    const by = jobs();
    expect(by.test?.verdict).toBe("fail");
    expect(by.test?.reason).toContain("cannot tell");
    expect(by.plain).toMatchObject({ verdict: "run", mode: "host" });
  });

  test("a docker command is still refused even with a Docker-capable class", () => {
    const wf = `on: push
jobs:
  d:
    runs-on: ubuntu-latest
    services:
      pg: { image: postgres:16 }
    steps:
      - uses: docker://alpine:3
`;
    const p = previewWorkflow(wf, {
      defaultBranch: "main",
      vars: {},
      containerJobs: capability(sizes(), { dockerInSandbox: true }),
    })!;
    expect(p.jobs[0]?.verdict).toBe("fail");
  });
});
