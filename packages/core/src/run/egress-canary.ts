import type { Provider } from "@turntable/provider-sdk";

/**
 * Egress canary. When a job's policy is `none`, the sandbox must really have no way out. Before
 * the job runs, a short command inside the sandbox tries to open a connection to a public address
 * and to the cloud metadata address; if either connects, the policy is not being enforced and
 * the job must not run (it would hold secrets or untrusted code with a network).
 *
 * Addresses are IPs, so DNS being down cannot hide a hole. Exit codes of the probe:
 *   0   every target is unreachable (verified)
 *   10  a target answered (a breach)
 *   125 no tool to test with: curl, wget, nc or bash (unknown)
 */
export const CANARY_TARGETS: readonly string[] = ["1.1.1.1:80", "169.254.169.254:80"];

const PROBE_SH = String.raw`
tool=
if command -v curl >/dev/null 2>&1; then tool=curl
elif command -v wget >/dev/null 2>&1; then tool=wget
elif command -v nc >/dev/null 2>&1; then tool=nc
elif command -v bash >/dev/null 2>&1; then tool=bash
fi
[ -n "$tool" ] || exit 125
# $mode is direct (proxy variables unset, so the network itself is tested) or env (the
# environment as a job step sees it, so a forwarding proxy is caught too).
probe() {
  for t in "$@"; do
    h=\${t%:*}; p=\${t##*:}
    case $tool in
      curl)
        if [ "$mode" = direct ]; then
          code=$(curl --noproxy '*' -s -m 3 --connect-timeout 3 -o /dev/null -w '%{http_code}' "http://$h:$p/" 2>/dev/null)
        else
          code=$(curl -s -m 3 --connect-timeout 3 -o /dev/null -w '%{http_code}' "http://$h:$p/" 2>/dev/null)
        fi
        [ -n "$code" ] && [ "$code" != 000 ] && { echo "reachable $t curl $mode http $code"; exit 10; } ;;
      wget)
        wget -q -T 3 -t 1 -O /dev/null "http://$h:$p/" >/dev/null 2>&1; rc=$?
        # 0: fetched; 8: the server answered with an error. Either way something answered.
        [ $rc -eq 0 ] || [ $rc -eq 8 ] && { echo "reachable $t wget $mode exit $rc"; exit 10; } ;;
      nc)
        nc -z -w 3 "$h" "$p" >/dev/null 2>&1 && { echo "reachable $t nc $mode tcp connect"; exit 10; } ;;
      bash)
        timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" >/dev/null 2>&1 && { echo "reachable $t bash $mode tcp connect"; exit 10; } ;;
    esac
  done
  return 0
}
# Only curl and wget take a proxy from their environment or config (~/.curlrc, ~/.wgetrc, which
# the direct pass's --noproxy overrides), so also run a pass as a job step sees it. A proxy
# does not matter to nc or bash. The passes run side by side so the worst case stays one pass
# (targets x 3s), inside the probe's wall clock.
# Each pass writes to its own file and the direct verdict is printed first, so the reported
# detail does not depend on which pass finished first.
o1=$(mktemp 2>/dev/null)
# No writable temp directory: fall back to the working directory, then the home directory.
[ -n "$o1" ] && [ -w "$o1" ] || { o1=./.canary1.$$; : >"$o1" 2>/dev/null || o1="\${HOME:-.}/.canary1.$$"; }
o2="$o1.env"
mode=direct
( unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; probe "$@" ) >"$o1" 2>&1 &
p1=$!
p2=
if [ "$tool" = curl ] || [ "$tool" = wget ]; then
  ( mode=env; probe "$@" ) >"$o2" 2>&1 &
  p2=$!
fi
wait $p1; rc1=$?
rc2=0
[ -z "$p2" ] || { wait $p2; rc2=$?; }
cat "$o1" "$o2" 2>/dev/null
rm -f "$o1" "$o2"
[ $rc1 -eq 0 ] || exit $rc1
exit $rc2
`.replace(/\\\$/g, "$");

export type CanaryVerdict =
  | { kind: "blocked" }
  | { kind: "reachable"; target: string; detail?: string }
  | { kind: "unknown"; why: string };

export type CanaryOptions = {
  targets?: readonly string[];
  pollMs?: number;
  /** Wall clock for the probe, seconds. Default 30. */
  timeoutSeconds?: number;
  signal?: AbortSignal | undefined;
};

const dec = new TextDecoder();

/** Runs the canary inside `sandboxId` through the provider's detached exec. */
export async function probeEgress(
  provider: Provider,
  sandboxId: string,
  o: CanaryOptions = {},
): Promise<CanaryVerdict> {
  const timeoutSeconds = o.timeoutSeconds ?? 30;
  const { execId } = await provider.exec.start(sandboxId, {
    argv: ["sh", "-c", PROBE_SH, "canary", ...(o.targets ?? CANARY_TARGETS)],
    timeoutSeconds,
  });
  const deadline = Date.now() + (timeoutSeconds + 15) * 1000;
  for (;;) {
    if (o.signal?.aborted) return { kind: "unknown", why: "cancelled" };
    const s = await provider.exec.status(sandboxId, execId);
    if (s.state !== "running") {
      if (s.state !== "exited") return { kind: "unknown", why: `probe ${s.state}` };
      if (s.exitCode === 0) return { kind: "blocked" };
      if (s.exitCode === 125)
        return { kind: "unknown", why: "no curl, wget, nc or bash in the image" };
      if (s.exitCode === 10) {
        const logs = await provider.exec.logs(sandboxId, execId, { fromOffset: 0, maxBytes: 4096 });
        const m = /reachable (\S+)(?: (.*))?/.exec(dec.decode(logs.bytes));
        // The probe output comes from inside the sandbox: cap what reaches an error message.
        const detail = m?.[2]?.trim().slice(0, 120);
        return {
          kind: "reachable",
          target: m?.[1]?.slice(0, 64) ?? "a target",
          ...(detail ? { detail } : {}),
        };
      }
      return { kind: "unknown", why: `probe exited ${s.exitCode}` };
    }
    if (Date.now() > deadline) return { kind: "unknown", why: "probe timed out" };
    await Bun.sleep(o.pollMs ?? 250);
  }
}

const PROXY_PROBE_SH = String.raw`
command -v curl >/dev/null 2>&1 || exit 125
code=$(curl -s -m 5 --connect-timeout 5 -o /dev/null -w '%{http_code}' -x "http://$1:$2" "http://proxy-canary.invalid/" 2>/dev/null)
[ -n "$code" ] && [ "$code" != 000 ] && exit 0
exit 10
`;

export type ProxyVerdict = { kind: "open" } | { kind: "closed"; why: string };

/**
 * Whether the sandbox can reach the secrets proxy at the address it was given. A plain-HTTP
 * request through the proxy is refused by it (it only tunnels), but any HTTP answer shows the
 * path is open.
 */
export async function probeProxy(
  provider: Provider,
  sandboxId: string,
  proxy: { host: string; port: number },
  o: CanaryOptions = {},
): Promise<ProxyVerdict> {
  const timeoutSeconds = o.timeoutSeconds ?? 30;
  const { execId } = await provider.exec.start(sandboxId, {
    argv: ["sh", "-c", PROXY_PROBE_SH, "canary", proxy.host, String(proxy.port)],
    timeoutSeconds,
  });
  const deadline = Date.now() + (timeoutSeconds + 15) * 1000;
  for (;;) {
    if (o.signal?.aborted) return { kind: "closed", why: "cancelled" };
    const s = await provider.exec.status(sandboxId, execId);
    if (s.state !== "running") {
      if (s.state === "exited" && s.exitCode === 0) return { kind: "open" };
      if (s.state === "exited" && s.exitCode === 125) {
        return { kind: "closed", why: "no curl in the image" };
      }
      return { kind: "closed", why: s.state === "exited" ? "no answer" : `probe ${s.state}` };
    }
    if (Date.now() > deadline) return { kind: "closed", why: "probe timed out" };
    await Bun.sleep(o.pollMs ?? 250);
  }
}
