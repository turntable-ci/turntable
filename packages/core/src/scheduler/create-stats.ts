// Sandbox create outcomes per provider (#814), kept in this process like the egress state: a
// restart starts empty. Doctor reads the recent timeout rate. Nothing here carries provider text.

const WINDOW_MS = 60 * 60_000;

type Sample = { at: number; timedOut: boolean };

/** True when a create failure's reason reads as a timeout (the provider's request or its start wait). */
export function isCreateTimeout(reason: string | undefined): boolean {
  return /timeout|timed out|did not start within/i.test(reason ?? "");
}

/** True for Daytona's "failed to resolve container IP ... Is the Sandbox started?" (#814). */
export function isSandboxLostMessage(reason: string | undefined): boolean {
  return /failed to resolve container ip|is the sandbox started/i.test(reason ?? "");
}

export class CreateStats {
  readonly #samples = new Map<string, Sample[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(provider: string, timedOut: boolean): void {
    const at = this.#now();
    const list = (this.#samples.get(provider) ?? []).filter((x) => at - x.at < WINDOW_MS);
    list.push({ at, timedOut });
    this.#samples.set(provider, list);
  }

  /** Creates and timeouts in the last hour, per provider. */
  snapshot(): { provider: string; creates: number; timeouts: number }[] {
    const at = this.#now();
    const out: { provider: string; creates: number; timeouts: number }[] = [];
    for (const [provider, list] of this.#samples) {
      const recent = list.filter((x) => at - x.at < WINDOW_MS);
      if (recent.length === 0) continue;
      out.push({
        provider,
        creates: recent.length,
        timeouts: recent.filter((x) => x.timedOut).length,
      });
    }
    return out;
  }
}

export const processCreateStats = new CreateStats();
