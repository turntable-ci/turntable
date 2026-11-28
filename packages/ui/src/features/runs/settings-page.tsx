import { Lock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/features/settings/settings-section";
import { useScope } from "@/features/shell/scope";
import { useWhoami } from "@/lib/directory";
import { EgressSection } from "./egress-section";
import { PrPolicySection } from "./pr-policy-section";
import { ProjectSecretsSection } from "./project-secrets-section";
import { RemoveProject } from "./remove-project";

export function SettingsPage() {
  const scope = useScope();
  const who = useWhoami();
  if (scope.projects && scope.project === null)
    return <EmptyState title="Project not found">Pick a project from the sidebar.</EmptyState>;
  const rows: [string, string][] = [
    ["Name", scope.project?.name ?? ""],
    ["Slug", scope.project?.slug ?? ""],
    ["Repository", scope.project?.repo ?? ""],
  ];
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
      <p className="mt-0.5 text-sm text-dim">
        The project's identity is read-only. Its settings below show where each value comes from.
      </p>
      <dl className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-4 px-4 py-3 text-sm">
            <dt className="w-32 shrink-0 text-dim">{k}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[13px]">
              <span className="min-w-0 flex-1 truncate">{v || "-"}</span>
              <Lock className="size-3.5 shrink-0 text-faint" role="img" aria-label="Read-only" />
            </dd>
          </div>
        ))}
      </dl>
      {scope.project ? (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">Settings</h2>
          <SettingsSection key={scope.project.id} project={scope.project.slug} />
        </div>
      ) : null}
      {scope.project ? (
        <EgressSection
          key={`egress-${scope.project.id}`}
          project={scope.project.slug}
          role={who.data?.role ?? null}
        />
      ) : null}
      {scope.project ? (
        <PrPolicySection
          key={`pr-policy-${scope.project.id}`}
          project={scope.project.slug}
          role={who.data?.role ?? null}
        />
      ) : null}
      {scope.project && scope.orgSlug ? (
        <ProjectSecretsSection
          key={`secrets-${scope.project.id}`}
          org={scope.orgSlug}
          project={scope.project.slug}
        />
      ) : null}
      {scope.project && scope.orgSlug ? (
        <RemoveProject
          org={scope.orgSlug}
          project={scope.project.slug}
          role={who.data?.role ?? null}
        />
      ) : null}
      <p className="mt-6 text-sm text-dim">
        Secrets, environments and approval rules will live here. Secret values are never shown in
        the UI.
      </p>
    </div>
  );
}
