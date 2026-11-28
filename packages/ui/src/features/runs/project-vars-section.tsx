// A project's workflow variables (`vars.*`), on its settings page: list, add, edit, delete.
// Plain text, not secrets: the section says so. TURNTABLE_CI is set by Turntable and read-only.
import { useState } from "react";
import type { ProjectVar } from "@/api/onboarding";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getOnboardingApi } from "@/features/onboarding/api";
import { meetsRole, type Role } from "@/lib/roles";
import { useAsync } from "@/lib/use-async";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Why a name is refused before the server is asked, or null. */
export function varNameProblem(name: string): string | null {
  if (!NAME.test(name)) return "Use letters, digits and underscores, starting with a letter or _.";
  if (/^github_/i.test(name)) return "A name cannot start with GITHUB_.";
  return null;
}

export function ProjectVarsPanel({
  vars,
  canEdit,
  busy,
  error,
  onSave,
  onDelete,
}: {
  vars: ProjectVar[];
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  onSave: (name: string, value: string) => void;
  onDelete: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const problem = name === "" ? null : varNameProblem(name);
  return (
    <section className="mt-8" aria-label="Variables" data-section="project-vars">
      <h2 className="mb-1 text-sm font-semibold">Variables</h2>
      <p className="mb-3 text-[13px] text-dim">
        Read by workflows as <span className="font-mono">vars.NAME</span>, for example public client
        keys. Values are stored and shown as plain text: use a secret for anything sensitive.
      </p>
      {vars.length === 0 ? (
        <p className="text-sm text-dim">No variables yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {vars.map((v) => (
            <li key={v.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-48 shrink-0 truncate font-mono text-[13px]">{v.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-dim">
                {v.value}
              </span>
              {v.reserved ? (
                <span className="text-xs text-dim">Set by Turntable</span>
              ) : canEdit ? (
                <span className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Edit ${v.name}`}
                    onClick={() => {
                      setName(v.name);
                      setValue(v.value);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Delete ${v.name}`}
                    onClick={() => onDelete(v.name)}
                  >
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name === "" || problem) return;
            onSave(name, value);
            setName("");
            setValue("");
          }}
        >
          <Input
            aria-label="Variable name"
            className="w-48 font-mono text-[13px]"
            placeholder="VITE_PUBLIC_KEY"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Variable value"
            className="min-w-48 flex-1 font-mono text-[13px]"
            placeholder="value"
            maxLength={1024}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || name === "" || problem !== null}>
            Save
          </Button>
        </form>
      ) : null}
      {problem ? <p className="mt-1.5 text-xs text-st-failure">{problem}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-st-failure">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ProjectVarsSection({
  org,
  project,
  role,
}: {
  org: string;
  project: string;
  role: Role | null;
}) {
  const api = getOnboardingApi();
  const list = useAsync(() => api.listProjectVars({ org, project }), [api, org, project]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Skeleton className="mt-8 h-16 w-full" />;
  return (
    <ProjectVarsPanel
      vars={list.data}
      canEdit={role !== null && meetsRole(role, "release_operator")}
      busy={busy}
      error={error}
      onSave={(name, value) => void run(() => api.setProjectVar({ org, project, name, value }))}
      onDelete={(name) => void run(() => api.deleteProjectVar({ org, project, name }))}
    />
  );
}
