import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drain,
  planJob,
  planWorkflow,
  resolveActions,
  runJob,
  splitJob,
  staticResolver,
  tarDirectory,
  type JobResult,
  type RunEvent,
} from "@turntable/act-runner";
import { DaytonaProvider } from "@turntable/provider-daytona";
import { DEFAULT_DOCKER_JOB_IMAGE } from "../src/scheduler/act-runner";

// LIVE (#796): a job with a Postgres service, on a real Daytona sandbox with a Docker daemon, run
// exactly as the scheduler runs a docker-class job (splitJob, then planJob in container mode, then
// runJob with the `docker info` preflight). It only runs when TT_DAYTONA_SERVICES_LIVE=1, with
//   TT_DAYTONA_DOCKER_SNAPSHOT  the Docker-capable snapshot of the operator's `docker: true` class
//   TT_DAYTONA_KEY_ENV          the name of the env var holding the API key (default DAYTONA_API_KEY)
//   TT_DAYTONA_BASE_URL         optional
// The sandbox has open egress (the images are pulled), at most 1 live, and is deleted after each
// test. The key is read by the provider from the named variable and never printed.
const live = process.env.TT_DAYTONA_SERVICES_LIVE === "1";
const snapshot = process.env.TT_DAYTONA_DOCKER_SNAPSHOT;

// The customer shape: steps reach the service on localhost:5432, gated on its health check.
// The connect step speaks Postgres's SSLRequest from the job container (bash /dev/tcp) and expects
// the server's one-byte answer (`N`), so it proves a Postgres server answered, not just an open port.
const PG_PROBE = `pg_probe() { exec 3<>"/dev/tcp/$1/$2" || { echo probe=refused; return 2; }; printf '\\x00\\x00\\x00\\x08\\x04\\xd2\\x16\\x2f' >&3; echo "probe=pg-$(timeout 5 head -c1 <&3)"; exec 3>&-; }`;

const WORKFLOW = `name: services
on: push
jobs:
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: x
        ports:
          - 5432:5432
        options: --health-cmd pg_isready --health-interval 2s --health-timeout 5s --health-retries 30
    steps:
      - name: connect on localhost
        shell: bash
        run: |
          ${PG_PROBE}
          pg_probe 127.0.0.1 "\${{ job.services.postgres.ports[5432] }}"
      - name: ports context
        run: echo "ports-context=\${{ job.services.postgres.ports['5432'] }}"
      - name: not published beyond loopback
        shell: bash
        run: |
          ip=$(hostname -I | awk '{print $1}')
          if [ -z "$ip" ]; then echo "no non-loopback address"; exit 1; fi
          if timeout 5 bash -c "exec 3<>/dev/tcp/$ip/5432" 2>/dev/null; then echo "outside=reachable"; exit 1; fi
          echo "outside=refused"
  sick:
    runs-on: ubuntu-latest
    services:
      bad:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: x
        options: --health-cmd "exit 1" --health-interval 1s --health-timeout 1s --health-retries 1
    steps:
      - run: echo "this step must never run"
`;

const tmp = mkdtempSync(join(tmpdir(), "tt-services-live-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function repoTarball(): Promise<Uint8Array> {
  const dir = join(tmp, `repo-${Date.now()}`);
  const git = async (...args: string[]) => {
    const p = Bun.spawn(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "gc.auto=0", ...args],
      { cwd: dir, stdout: "ignore", stderr: "inherit" },
    );
    if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  };
  rmSync(dir, { recursive: true, force: true });
  await Bun.write(join(dir, ".github/workflows/services.yml"), WORKFLOW);
  writeFileSync(join(dir, "README"), "services e2e\n");
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "services e2e");
  return tarDirectory(dir);
}

/** The scheduler's path for a docker-class job: split, then plan in container mode. */
function containerPlan(jobId: string) {
  const push = { name: "push", ref: "refs/heads/main" } as const;
  const readFile = (): undefined => undefined;
  const planned = planWorkflow(WORKFLOW, push, { readFile }).jobs.find((j) => j.id === jobId)!;
  expect(planned.needsDocker).toBe("uses services:");
  const yaml = splitJob(WORKFLOW, planned, {}, { event: "push" });
  return {
    yaml,
    plan: planJob(yaml, planned.id, {
      workflowPath: `.turntable/jobs/${jobId}.yml`,
      event: "push",
      readFile,
      split: true,
      docker: { image: DEFAULT_DOCKER_JOB_IMAGE },
    }),
  };
}

// Offline: the live workflow plans, its port binds loopback and the ports context is literal.
test("the live workflow plans in container mode", () => {
  const { yaml, plan } = containerPlan("db");
  expect(yaml).toContain("127.0.0.1:5432:5432");
  expect(yaml).toContain("ports-context=${{ '5432' }}");
  expect(plan.docker?.images).toContain("postgres:16");
  expect(containerPlan("sick").plan.docker?.images).toContain("postgres:16");
});

async function runOnDaytona(jobId: string): Promise<{ result: JobResult; log: string }> {
  const plan = await resolveActions(containerPlan(jobId).plan, staticResolver({}));
  const provider = new DaytonaProvider({
    apiKey: { env: process.env.TT_DAYTONA_KEY_ENV ?? "DAYTONA_API_KEY" },
    runId: `svc-${crypto.randomUUID().slice(0, 8)}`,
    maxLive: 1,
    ...(process.env.TT_DAYTONA_BASE_URL ? { baseUrl: process.env.TT_DAYTONA_BASE_URL } : {}),
  });
  expect(provider.info.dockerInSandbox).toBe(true);
  const { id } = await provider.create({
    name: `tt-services-${jobId}-${Date.now()}`,
    labels: { tt_services_e2e: jobId },
    snapshot: snapshot!,
    ttlSeconds: 1800,
    network: { egress: "open" },
  });
  try {
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(
        provider,
        id,
        plan,
        { repoTarball: await repoTarball(), docker: { egress: "open", waitSeconds: 60 } },
        { timeoutSeconds: 900 },
      ),
      (e) => {
        events.push(e);
        if (e.kind === "act" && e.event.type === "step-end") {
          console.log(`[${jobId}] step ${e.event.name}: ${e.event.result}`);
        }
      },
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    return { result, log };
  } finally {
    await provider.destroy(id);
  }
}

describe.skipIf(!live || !snapshot)("services on Daytona (live, #796)", () => {
  test("a Postgres service: steps connect on localhost:5432 after its health check", async () => {
    const { result, log } = await runOnDaytona("db");
    if (result.state !== "success") console.log(JSON.stringify(result), `\n${log}`);
    expect(result.state).toBe("success");
    expect(log).toContain("probe=pg-N");
    expect(log).toContain("ports-context=5432");
    expect(log).toContain("outside=refused");
  }, 1_200_000);

  test("a service that never becomes healthy is a named infra failure; no step runs", async () => {
    const { result, log } = await runOnDaytona("sick");
    expect(result).toMatchObject({ state: "infra_error", infraKind: "service_unhealthy" });
    expect(log).not.toContain("this step must never run\n");
  }, 1_200_000);
});
