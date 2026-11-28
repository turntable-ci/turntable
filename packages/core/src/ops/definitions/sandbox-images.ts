// register_sandbox_image (#809): the instance operator asks the provider to make a snapshot from a
// registry image pinned by digest, and Turntable records its name and digest. Sandboxes then start
// from the snapshot by name: nothing pulls an image by tag at run time.
import { z } from "zod";
import { InfraError, SpecError, parsePinnedImage } from "@turntable/provider-sdk";
import {
  appendAudit,
  getOrgBySlug,
  getProjectBySlug,
  getProjectSandboxSettings,
  setProjectSandboxSettings,
  SNAPSHOT_NAME,
} from "../../db/repos";
import {
  getSandboxImage,
  putSandboxImage,
  OWN_REGISTRY,
  type SandboxImage,
} from "../../db/repos/sandbox-images";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { defineOp } from "../define";
import { OpError } from "../errors";

/** The default image's snapshot name, the one `ubuntu-latest` maps to in the docs' size config. */
export const DEFAULT_IMAGE_NAME = "turntable-ubuntu-24.04";

export const sandboxImageShape = z.object({
  name: z.string().describe("The provider snapshot sandboxes start from."),
  image: z.string().describe("The registry image it was made from: repository@sha256:..."),
  digest: z.string().describe("The image digest, sha256:<64 hex>."),
  source: z
    .enum(["turntable", "operator"])
    .describe(
      "turntable: Turntable's own registry (ghcr.io/turntable-ci/); operator: a ref the operator chose.",
    ),
  state: z.enum(["pending", "ready"]).describe("pending: the provider is still building it."),
});

export function imageView(i: SandboxImage): z.infer<typeof sandboxImageShape> {
  return { name: i.name, image: i.image, digest: i.digest, source: i.source, state: i.state };
}

export const registerSandboxImage = defineOp({
  name: "register_sandbox_image",
  summary: "Register a digest-pinned image as a provider snapshot (instance administrator only).",
  description:
    "Asks the instance's sandbox provider to create a snapshot named `name` from `image`, a " +
    "registry image pinned by digest (`repository@sha256:<64 hex>`; a tag alone is refused, and a " +
    "tag next to the digest is dropped), with the provider's own credentials, and records the " +
    "name and digest. Sandboxes then start from the snapshot by name, so no image is pulled by " +
    "tag at run time. Turntable's default image is `ghcr.io/turntable-ci/turntable-ubuntu-24.04`; " +
    "any other ref is recorded as operator-registered. Naming `target_org` and `target_project` " +
    "also points that project at the snapshot (its `sandbox_snapshot`, shown by " +
    "`get_project_settings`). Registering a name again with the same digest is a no-op that " +
    "refreshes its state; another digest under a taken name is a conflict (register a new name). " +
    "Map `ubuntu-latest` to it with the size config's default class " +
    "(`providers.daytona.snapshot`). Audited. Not an MCP tool.",
  input: z.object({
    name: z.string().min(1).max(128).describe("Snapshot name: letters, digits, . _ -."),
    image: z.string().min(1).max(512).describe("Registry image pinned by digest."),
    cpus: z.int().min(1).max(256).optional(),
    memory_mb: z.int().min(256).max(2_097_152).optional(),
    disk_gb: z.int().min(1).max(16_384).optional(),
    target_org: z.string().min(1).max(64).optional().describe("Slug of the org of target_project."),
    target_project: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Slug of a project to start from this snapshot."),
  }),
  output: sandboxImageShape.extend({
    project: z.string().nullable().describe("The project now starting from it, if one was named."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/sandbox-images" },
  mcp: false,
  // The provider call is a slow round trip (Daytona POST /snapshots, up to 60 s): it must not run
  // inside the write transaction, which on SQLite blocks every other database user. The handler
  // writes the record, the project pointer and the project audit row in one short transaction
  // after the provider answers; the dispatcher audits the call itself afterwards.
  outsideTransaction: true,
  auditDetail: (o) => ({ digest: o.digest, state: o.state }),
  async handler(ctx, i) {
    if (!SNAPSHOT_NAME.test(i.name))
      throw new OpError(
        "invalid_input",
        "a snapshot name is letters, digits, . _ - (up to 128, starting alphanumeric)",
      );
    const pinned = parsePinnedImage(i.image);
    if (!pinned)
      throw new OpError(
        "invalid_input",
        "the image must be pinned by digest: repository@sha256:<64 hex> (a tag can be moved, a digest cannot)",
      );
    if ((i.target_org === undefined) !== (i.target_project === undefined))
      throw new OpError("invalid_input", "name both target_org and target_project, or neither");
    // The project is resolved before the provider is called, so a typo creates no snapshot.
    let target: { orgId: string; orgSlug: string; projectId: string; projectSlug: string } | null =
      null;
    if (i.target_org !== undefined && i.target_project !== undefined) {
      const org = await getOrgBySlug(ctx.db, i.target_org);
      if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
      const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
      if (!project) throw new OpError("not_found", "no such project");
      target = {
        orgId: org.id,
        orgSlug: org.slug,
        projectId: project.id,
        projectSlug: project.slug,
      };
    }
    const had = await getSandboxImage(ctx.db, i.name);
    if (had && had.digest !== pinned.digest)
      throw new OpError(
        "conflict",
        `snapshot ${i.name} is already registered with another digest; register the new image under a new name`,
      );
    const registrar = ctx.imageRegistrar?.();
    if (!registrar)
      throw new OpError(
        "unavailable",
        "this instance's sandbox provider cannot register images (or no provider runs in this process)",
      );
    const image = `${pinned.repository}@${pinned.digest}`;
    let made;
    try {
      made = await registrar.register({
        name: i.name,
        image,
        ...(i.cpus !== undefined || i.memory_mb !== undefined || i.disk_gb !== undefined
          ? {
              resources: {
                ...(i.cpus !== undefined ? { cpus: i.cpus } : {}),
                ...(i.memory_mb !== undefined ? { memoryMb: i.memory_mb } : {}),
                ...(i.disk_gb !== undefined ? { diskGb: i.disk_gb } : {}),
              },
            }
          : {}),
      });
    } catch (e) {
      // Fixed words: provider error text can carry upstream detail.
      if (e instanceof SpecError)
        throw new OpError(
          "invalid_input",
          `the provider refused the image: ${e.message.slice(0, 200)}`,
        );
      if (e instanceof InfraError)
        throw new OpError("unavailable", "the provider could not register the image; try again");
      throw e;
    }
    if (made.digest !== pinned.digest)
      throw new OpError("internal", "the provider registered a different digest than was asked");
    const record: SandboxImage = {
      name: i.name,
      image,
      digest: pinned.digest,
      source: pinned.repository.startsWith(OWN_REGISTRY) ? "turntable" : "operator",
      provider: registrar.provider,
      state: made.state,
      registeredBy: ctx.principal.id,
      registeredAt: ctx.now(),
    };
    let projectGone = false;
    await ctx.db.transaction(
      async (tx) => {
        await putSandboxImage(tx, record);
        if (!target) return;
        const scope = { orgId: target.orgId, projectId: target.projectId };
        const from = await getProjectSandboxSettings(tx, scope);
        const updated = await setProjectSandboxSettings(
          tx,
          scope,
          { sandboxSnapshot: i.name },
          { id: ctx.principal.id, now: ctx.now() },
        );
        if (updated === undefined) {
          // The project was deleted while the provider call ran: keep the snapshot record only.
          projectGone = true;
          return;
        }
        await appendAudit(tx, scope, {
          principalKind: "instance",
          principalId: ctx.principal.id,
          op: "register_sandbox_image",
          effect: "write",
          outcome: "ok",
          input: {
            target_org: target.orgSlug,
            target_project: target.projectSlug,
            name: i.name,
            digest: pinned.digest,
            from: from.sandboxSnapshot,
          },
        });
      },
      target ? { lock: `audit:${target.orgId}` } : {},
    );
    if (projectGone) {
      // The snapshot exists and is recorded: say so in the instance audit row.
      throw new OpError("not_found", "no such project", undefined, {
        digest: pinned.digest,
        state: made.state,
        recorded: true,
      });
    }
    return { ...imageView(record), project: target?.projectId ?? null };
  },
});
