// The project's default sandbox egress. An owner may only tighten it (open, then allowlist, then
// none); widening is the instance operator's control. The server enforces both.
import { useState } from "react";
import { getBackend } from "@/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { meetsRole, type Role } from "@/lib/roles";
import { useAsync } from "@/lib/use-async";

type Mode = "none" | "allowlist" | "open";
const RANK: Record<Mode, number> = { open: 0, allowlist: 1, none: 2 };
const MODES: Mode[] = ["open", "allowlist", "none"];

export function EgressPanel({
  current,
  canEdit,
  busy,
  error,
  warnings,
  onTighten,
}: {
  current: Mode;
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  warnings: string[];
  onTighten: (m: Mode) => void;
}) {
  const tighter = MODES.filter((m) => RANK[m] > RANK[current]);
  return (
    <section data-section="egress" className="mt-8">
      <h2 className="text-base font-semibold tracking-tight">Sandbox egress</h2>
      <p className="mt-1 text-[13px] text-dim">
        Current default: <span className="font-mono">{current}</span>. A repo's own setting still
        overrides it. You can only tighten it here (open, then allowlist, then none); the instance
        operator widens it.
      </p>
      {canEdit && tighter.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {tighter.map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onTighten(m)}
            >
              Tighten to {m}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {warnings.map((w) => (
        <p key={w} className="mt-2 text-sm text-dim">
          {w}
        </p>
      ))}
    </section>
  );
}

export function EgressSection({ project, role }: { project: string; role: Role | null }) {
  const { api } = getBackend();
  const state = useAsync(() => api.getProjectEgress({ project }), [api, project]);
  const [override, setOverride] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  if (state.data === null) return state.error ? null : <Skeleton className="mt-8 h-16" />;
  const tighten = async (egress: Mode) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.tightenProjectEgress({ project, egress });
      setOverride(r.egress);
      setWarnings(r.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change egress");
    } finally {
      setBusy(false);
    }
  };
  return (
    <EgressPanel
      current={override ?? state.data}
      canEdit={role !== null && meetsRole(role, "owner")}
      busy={busy}
      error={error}
      warnings={warnings}
      onTighten={tighten}
    />
  );
}
