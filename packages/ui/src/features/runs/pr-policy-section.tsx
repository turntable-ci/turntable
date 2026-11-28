// The project's pull request policy: which PRs get a run. An owner or admin edits it; only an
// owner may widen it (more authors, or `approval`), and the server enforces that.
import { useState } from "react";
import { getBackend } from "@/api";
import type { PrMode, PrPolicy } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { meetsRole, type Role } from "@/lib/roles";
import { useAsync } from "@/lib/use-async";

const MODES: { mode: PrMode; help: string }[] = [
  { mode: "off", help: "pull requests never run" },
  { mode: "allowlist", help: "only same-repo PRs by a listed author run" },
  { mode: "approval", help: "other PRs wait for a maintainer to approve" },
];

/** One login per line or comma separated; a bot keeps its `[bot]` suffix. */
export const parseAuthors = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter((a) => a !== "");

export function PrPolicyPanel({
  current,
  canEdit,
  isOwner,
  busy,
  error,
  onSave,
}: {
  current: PrPolicy;
  canEdit: boolean;
  isOwner: boolean;
  busy: boolean;
  error: string | null;
  onSave: (p: { prMode: PrMode; authors: string[] }) => void;
}) {
  const [mode, setMode] = useState<PrMode>(current.prMode);
  const [text, setText] = useState(current.authors.join("\n"));
  return (
    <section data-section="pr-policy" className="mt-8">
      <h2 className="text-base font-semibold tracking-tight">Pull requests</h2>
      {!current.ingestEnabled ? (
        <p className="mt-1 text-[13px] text-dim">Ingest is not turned on for this project.</p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-dim">
            Current mode: <span className="font-mono">{current.prMode}</span>. A bot is listed by
            its login with the suffix, for example <span className="font-mono">name[bot]</span>. A
            PR skipped for its author shows in ingest status.
            {canEdit && !isOwner
              ? " You can remove authors or tighten the mode; an owner widens it."
              : ""}
          </p>
          {canEdit ? (
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                onSave({ prMode: mode, authors: parseAuthors(text) });
              }}
            >
              <label className="text-sm">
                Mode
                <select
                  className="ml-2 rounded border border-line bg-transparent px-2 py-1"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PrMode)}
                >
                  {MODES.map((m) => (
                    <option key={m.mode} value={m.mode}>
                      {m.mode}: {m.help}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Trusted authors
                <textarea
                  className="mt-1 block w-full max-w-md rounded border border-line bg-transparent px-2 py-1 font-mono text-[13px]"
                  rows={4}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <div>
                <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                  Save
                </Button>
              </div>
            </form>
          ) : (
            <p className="mt-2 font-mono text-[13px]">{current.authors.join(", ") || "-"}</p>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function PrPolicySection({ project, role }: { project: string; role: Role | null }) {
  const { api } = getBackend();
  const state = useAsync(() => api.getProjectPrPolicy({ project }), [api, project]);
  const [override, setOverride] = useState<PrPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.data === null) return state.error ? null : <Skeleton className="mt-8 h-16" />;
  const save = async (p: { prMode: PrMode; authors: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      setOverride(await api.changeProjectPrPolicy({ project, ...p }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the pull request policy");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PrPolicyPanel
      key={JSON.stringify(override)}
      current={override ?? state.data}
      canEdit={role !== null && meetsRole(role, "admin") && (override ?? state.data).ingestEnabled}
      isOwner={role !== null && meetsRole(role, "owner")}
      busy={busy}
      error={error}
      onSave={save}
    />
  );
}
