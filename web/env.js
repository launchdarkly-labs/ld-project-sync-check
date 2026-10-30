// Where the page runs and which view it opens in. No DOM here, so it can be tested.
//
//   hosted   GitHub Pages: anyone's browser, tokens typed in by hand
//   local    a file server on the operator's machine (deno task serve)
//   console  the local console of ld-migration-scripts, which answers GET api/console (Phase 5)

export const HOSTS = ["hosted", "local", "console"];
export const VIEWS = ["drift", "operator"];

/**
 * @param {{ hostname: string, probe?: () => Promise<unknown> }} where probe fetches api/console
 *   (same origin) and resolves to its JSON; any failure means there is no console
 */
export async function detectHost({ hostname, probe }) {
  if (hostname.endsWith(".github.io") || hostname === "github.io") return "hosted";
  if (probe) {
    try {
      const info = await probe();
      if (info && typeof info === "object" && info.console === true) return "console";
    } catch { /* no console */ }
  }
  return "local";
}

/** The view to open: ?view= first, then the saved choice, then the host's default. */
export function initialView({ host, search = "", saved = null }) {
  const asked = new URLSearchParams(search).get("view");
  if (VIEWS.includes(asked)) return asked;
  if (VIEWS.includes(saved)) return saved;
  return host === "hosted" ? "drift" : "operator";
}

/** The probe the page uses: same-origin, no credentials, JSON only. */
export async function probeConsole(fetchImpl = fetch, timeoutMs = 1500) {
  const res = await fetchImpl("api/console", { cache: "no-store", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) throw new Error("no console");
  return await res.json();
}
