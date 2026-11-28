import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { summarize, type ActEvent } from "../src/events";
import { INFRA_KINDS, isRetryableInfra } from "../src/infra-kind";
import { planJob, PlanError } from "../src/plan";
import { decide } from "../src/run-job";
import { bindServicePorts, prepareServices, substituteServiceRefs } from "../src/services";
import { splitJob } from "../src/split";
import { planWorkflow } from "../src/workflow-plan";

// The customer shape from #796: a Postgres service the steps reach on localhost:5432.
const WORKFLOW = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: x
        ports:
          - 5432:5432
        options: --health-cmd pg_isready --health-interval 2s --health-retries 30
      redis:
        image: redis:7
        ports:
          - 6379
    env:
      DATABASE_URL: postgres://postgres:x@localhost:\${{ job.services.postgres.ports[5432] }}/postgres
    steps:
      - name: connect
        if: job.services.postgres.ports['5432'] == '5432'
        run: pg_isready -h localhost -p "\${{ job.services.postgres.ports['5432'] }}"
      - run: echo "\${{ job.services.redis.ports["6379"] }} \${{ toJSON(job.services.redis.ports) }}"
      - run: echo job.services.postgres.ports[5432] stays text outside an expression
`;

const push = { name: "push", ref: "refs/heads/main" } as const;
const readFile = (): undefined => undefined;

type Obj = Record<string, any>;
const generated = (): Obj => {
  const planned = planWorkflow(WORKFLOW, push, { readFile }).jobs.find((j) => j.id === "test")!;
  return parse(splitJob(WORKFLOW, planned, {}, { event: "push" })).jobs.test as Obj;
};

describe("services ports bind loopback only (#796)", () => {
  test("every published port is rewritten to 127.0.0.1 with a fixed host port", () => {
    const job = generated();
    expect(job.services.postgres.ports).toEqual(["127.0.0.1:5432:5432"]);
    // No host port: the container port is free, so it is used.
    expect(job.services.redis.ports).toEqual(["127.0.0.1:6379:6379"]);
    // The rest of the service is untouched.
    expect(job.services.postgres.image).toBe("postgres:16");
    expect(job.services.postgres.env).toEqual({ POSTGRES_PASSWORD: "x" });
    expect(job.services.postgres.options).toContain("--health-cmd pg_isready");
  });

  test("an address other than loopback is replaced, and udp is kept", () => {
    const { services } = bindServicePorts({
      a: { image: "x", ports: ["0.0.0.0:8080:80", "53/udp"] },
    });
    expect((services.a as Obj).ports).toEqual(["127.0.0.1:8080:80", "127.0.0.1:53:53/udp"]);
  });

  test("a port without a host port that is taken goes to the next free port from 49152", () => {
    const { services, ports } = bindServicePorts({
      a: { image: "postgres", ports: [5432] },
      b: { image: "postgres", ports: ["5432"] },
      c: { image: "postgres", ports: ["49152:1"] },
    });
    expect((services.a as Obj).ports).toEqual(["127.0.0.1:5432:5432"]);
    expect((services.b as Obj).ports).toEqual(["127.0.0.1:49153:5432"]);
    expect(ports).toEqual({ a: { "5432": "5432" }, b: { "5432": "49153" }, c: { "1": "49152" } });
  });

  test("a range, an IPv6 address, a non-literal or a reused host port is refused", () => {
    for (const p of ["8000-8010:8000-8010", "[::1]:80:80", "${{ env.P }}", "", "70000"]) {
      expect(() => bindServicePorts({ a: { image: "x", ports: [p] } })).toThrow(PlanError);
    }
    expect(() => bindServicePorts({ a: { image: "x", ports: "5432" } })).toThrow(PlanError);
    expect(() =>
      bindServicePorts({
        a: { image: "x", ports: ["80:80"] },
        b: { image: "y", ports: ["80:81"] },
      }),
    ).toThrow("host port 80 is used twice");
  });

  test("a matrix port is interpolated with the leg before it is bound", () => {
    const yaml = `on: push
jobs:
  t:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        port: [5433]
    services:
      pg:
        image: postgres:16
        ports: ["\${{ matrix.port }}:5432"]
    steps:
      - run: echo
`;
    const planned = planWorkflow(yaml, push, { readFile }).jobs.find((j) => j.id === "t")!;
    const job = parse(splitJob(yaml, planned, {}, { event: "push" })).jobs.t as Obj;
    expect(job.services.pg.ports).toEqual(["127.0.0.1:5433:5432"]);
  });
});

describe("service options cannot publish ports (#796)", () => {
  for (const options of [
    "-p 5432:5432",
    "--publish 5432:5432",
    "--publish=5432",
    "-P",
    "-p5432:5432",
    "-tp 0.0.0.0:5432:5432",
    "-iP",
    "'-p' 0.0.0.0:5432:5432",
    '"--publish" 5432:5432',
    "--pub\\lish 5432:5432",
    "--rm -p 0.0.0.0:5432:5432",
    "--oom-kill-disable -p 0.0.0.0:5432:5432",
    "-\\\np 0.0.0.0:5432:5432",
    '"\\-e" -p 0.0.0.0:5432:5432',
    '"\\--env" -p 0.0.0.0:5432:5432',
    "--label=a\u00a0--env -p 0.0.0.0:5432:5432",
  ]) {
    test(`refuses ${options}`, () => {
      expect(() =>
        bindServicePorts({ db: { image: "postgres:16", ports: ["5432:5432"], options } }),
      ).toThrow(/publish a port/);
    });
  }
  for (const options of [
    '--health-cmd "pg_isready -h localhost -p 5432"',
    '--health-cmd "redis-cli -p 6379 ping"',
    '--health-cmd="mysqladmin ping -h 127.0.0.1 -P 3306"',
    "--health-cmd 'pg_isready -p 5432' --health-retries 5",
  ]) {
    test(`allows ${options}`, () => {
      const r = bindServicePorts({ db: { image: "p", ports: ["5432"], options } });
      expect(r.ports.db).toEqual({ "5432": "5432" });
    });
  }
  for (const options of [
    "${{ matrix.opts }}",
    "--health-cmd pg_isready ${{ vars.X }}",
    "${{ format('-{0} 5432:5432', 'p') }}",
  ]) {
    test(`refuses an expression in options: ${options}`, () => {
      expect(() => bindServicePorts({ db: { image: "p", ports: ["5432"], options } })).toThrow(
        /cannot use an expression/,
      );
    });
  }
  test("tcp and udp on the same host port do not collide", () => {
    const r = bindServicePorts({ dns: { image: "d", ports: ["53:53/tcp", "53:53/udp"] } });
    expect(r.services.dns).toEqual({
      image: "d",
      ports: ["127.0.0.1:53:53", "127.0.0.1:53:53/udp"],
    });
  });
  test("keeps a health command and other options", () => {
    const r = bindServicePorts({
      db: { image: "p", ports: ["5432"], options: "--health-cmd pg_isready --pids-limit 100" },
    });
    expect(r.ports.db).toEqual({ "5432": "5432" });
  });
});

describe("job.services.<id>.ports context (#796)", () => {
  test("references in expressions, env and bare step if become the literal host port", () => {
    const job = generated();
    expect(job.env.DATABASE_URL).toBe("postgres://postgres:x@localhost:${{ '5432' }}/postgres");
    expect(job.steps[0].if).toBe("'5432' == '5432'");
    expect(job.steps[0].run).toBe(`pg_isready -h localhost -p "\${{ '5432' }}"`);
    expect(job.steps[1].run).toBe(
      `echo "\${{ '6379' }} \${{ toJSON(fromJSON('{"6379":"6379"}')) }}"`,
    );
    // Plain text outside ${{ }} is the user's script: never rewritten.
    expect(job.steps[2].run).toContain("job.services.postgres.ports[5432] stays text");
  });

  test("the forms GitHub accepts, an undeclared port, and an unknown service", () => {
    const ports = { Postgres: { "5432": "49152" } };
    expect(substituteServiceRefs("job.services.postgres.ports[5432]", ports)).toBe("'49152'");
    expect(substituteServiceRefs('job.services.POSTGRES.ports["5432"]', ports)).toBe("'49152'");
    expect(substituteServiceRefs("job.services.postgres.ports.5432", ports)).toBe("'49152'");
    expect(substituteServiceRefs("job.services.postgres.ports[1]", ports)).toBe("''");
    expect(substituteServiceRefs("job.services.other.ports[1]", ports)).toBe(
      "job.services.other.ports[1]",
    );
    // An index act must evaluate is left to act.
    expect(substituteServiceRefs("job.services.postgres.ports[matrix.p]", ports)).toBe(
      "job.services.postgres.ports[matrix.p]",
    );
  });

  test("a job without services is returned as it was", () => {
    const job = { "runs-on": "x", steps: [{ run: "echo ${{ job.services.a.ports[1] }}" }] };
    expect(prepareServices(job)).toBe(job);
  });

  test("the container-mode plan of the generated workflow names the service image", () => {
    const planned = planWorkflow(WORKFLOW, push, { readFile }).jobs.find((j) => j.id === "test")!;
    expect(planned.needsDocker).toBe("uses services:");
    const yaml = splitJob(WORKFLOW, planned, {}, { event: "push" });
    const plan = planJob(yaml, "test", {
      workflowPath: ".turntable/jobs/test.yml",
      event: "push",
      readFile,
      split: true,
      docker: { image: "runner:1" },
    });
    expect(plan.docker?.images).toEqual(["runner:1", "postgres:16", "redis:7"]);
  });
});

describe("health-check gating (#796)", () => {
  // What act v0.2.97 emits when waitForServiceContainers gives up.
  const unhealthy: ActEvent[] = [
    { type: "job-start", jobId: "test", inferred: true, time: "t" },
    { type: "error", jobId: "test", message: "service container failed to start", time: "t" },
    { type: "job-end", jobId: "test", result: "failure", time: "t" },
  ];

  test("a service that never became healthy is a named infra failure, not a job failure", () => {
    const sum = summarize(unhealthy);
    expect(sum.serviceUnhealthy).toBe(true);
    const r = decide({ state: "exited", exitCode: 1 }, sum);
    expect(r.state).toBe("infra_error");
    expect(r.infraKind).toBe("service_unhealthy");
    expect(r.reason).toContain("did not become healthy");
    expect(r.reason).toContain("steps did not start");
  });

  test("act's plain-text form is recognised too", () => {
    const sum = summarize([
      { type: "text", text: "Error: service container failed to start" },
    ] as ActEvent[]);
    expect(sum.serviceUnhealthy).toBe(true);
  });

  test("it happens before any step and is not retried", () => {
    expect(INFRA_KINDS.service_unhealthy.beforeSteps).toBe(true);
    expect(isRetryableInfra("service_unhealthy", "trusted_pr")).toBe(false);
  });

  test("a step's own error with the same words stays a job failure", () => {
    const sum = summarize([
      { type: "job-start", jobId: "test", inferred: true, time: "t" },
      {
        type: "step-start",
        jobId: "test",
        stepKey: "0",
        name: "Boom",
        stage: "Main",
        inferred: false,
        time: "t",
      },
      { type: "error", jobId: "test", message: "service container failed to start", time: "t" },
      { type: "job-end", jobId: "test", result: "failure", time: "t" },
    ]);
    expect(sum.serviceUnhealthy).toBeUndefined();
    expect(decide({ state: "exited", exitCode: 1 }, sum).state).toBe("failure");
  });

  test("a normal step failure stays a job failure", () => {
    const sum = summarize([
      { type: "job-start", jobId: "test", inferred: true, time: "t" },
      { type: "job-end", jobId: "test", result: "failure", time: "t" },
    ]);
    expect(decide({ state: "exited", exitCode: 1 }, sum).state).toBe("failure");
  });
});
