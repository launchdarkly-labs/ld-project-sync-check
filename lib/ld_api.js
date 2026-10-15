// Minimal LaunchDarkly REST client shared by the Deno CLI and the browser.
// - fetch is injectable (tests, custom runtimes)
// - follows _links.next for pagination
// - honours x-ratelimit-* headers when readable, falls back to fixed backoff otherwise
// - retries 429 (up to 5) and 5xx / network errors (up to 3)

export const API_VERSION = "20240415";

export class ApiError extends Error {
  constructor(message, { status, url, body }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeClient({
  baseUrl,
  token,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  apiVersion = API_VERSION,
  sleep = defaultSleep,
  log = () => {},
  maxRetries429 = 5,
  maxRetriesTransient = 3,
  signal = undefined,
}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!token) throw new Error("token is required");
  const origin = baseUrl.replace(/\/+$/, "");

  const toUrl = (path) => {
    if (/^https?:\/\//.test(path)) return path;
    if (path.startsWith("/")) return origin + path;
    return `${origin}/api/v2/${path}`;
  };

  async function getRaw(path) {
    const url = toUrl(path);
    const headers = { Authorization: token };
    if (apiVersion) headers["LD-API-Version"] = apiVersion;
    let attempt429 = 0;
    let attemptTransient = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, { headers, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attemptTransient >= maxRetriesTransient) {
          throw new ApiError(`Network error for ${url}: ${err?.message ?? err}`, { status: 0, url, body: String(err) });
        }
        const wait = 1000 * 2 ** attemptTransient + Math.floor(Math.random() * 250);
        log(`network error, retry ${attemptTransient + 1}/${maxRetriesTransient} in ${wait}ms: ${url}`);
        attemptTransient++;
        await sleep(wait);
        continue;
      }
      if (res.status === 429) {
        if (attempt429 >= maxRetries429) {
          throw new ApiError(`Rate limited (429) too many times: ${url}`, { status: 429, url, body: "" });
        }
        const wait = rateLimitWait(res.headers, attempt429);
        log(`429, waiting ${wait}ms: ${url}`);
        attempt429++;
        await sleep(wait);
        continue;
      }
      if ([500, 502, 503, 504].includes(res.status) && attemptTransient < maxRetriesTransient) {
        const wait = 1000 * 2 ** attemptTransient + Math.floor(Math.random() * 250);
        log(`HTTP ${res.status}, retry ${attemptTransient + 1}/${maxRetriesTransient} in ${wait}ms: ${url}`);
        attemptTransient++;
        await sleep(wait);
        continue;
      }
      await proactiveWait(res.headers, sleep, log);
      return res;
    }
  }

  async function get(path) {
    const res = await getRaw(path);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(`HTTP ${res.status} for ${res.url || toUrl(path)}`, { status: res.status, url: res.url || toUrl(path), body });
    }
    return await res.json();
  }

  /** Collect all items from a paginated endpoint. onPage(itemsSoFar, totalCount) is optional. */
  async function paginate(path, { itemsKey = "items", onPage, maxPages = 1000 } = {}) {
    const items = [];
    let next = path;
    let pages = 0;
    let totalCount;
    while (next && pages < maxPages) {
      const body = await get(next);
      pages++;
      const pageItems = body?.[itemsKey] ?? [];
      items.push(...pageItems);
      totalCount = body?.totalCount ?? totalCount;
      onPage?.(items.length, totalCount);
      const href = body?._links?.next?.href;
      if (href) {
        next = href;
      } else if (totalCount !== undefined && items.length < totalCount && pageItems.length > 0) {
        // Fallback for endpoints that omit _links.next but report totalCount.
        const u = new URL(toUrl(path));
        u.searchParams.set("offset", String(items.length));
        next = u.toString();
      } else {
        next = null;
      }
    }
    return items;
  }

  return {
    baseUrl: origin,
    get,
    getRaw,
    paginate,
    callerIdentity: () => get("caller-identity"),
    getProject: (projectKey) => get(`projects/${enc(projectKey)}`),
    listEnvironments: (projectKey, opts) =>
      paginate(`projects/${enc(projectKey)}/environments?limit=50`, opts),
    getEnvironment: (projectKey, envKey) =>
      get(`projects/${enc(projectKey)}/environments/${enc(envKey)}`),
    /** Full flag objects; `envs` restricts the environments returned (fewer bytes). */
    listFlags: (projectKey, { envs = [], archived = false, limit = 50, onPage } = {}) => {
      const q = new URLSearchParams({ summary: "false", limit: String(limit), offset: "0" });
      for (const e of envs) q.append("env", e);
      if (archived) q.set("filter", "state:archived");
      return paginate(`flags/${enc(projectKey)}?${q.toString()}`, { onPage });
    },
    listSegments: (projectKey, envKey, { limit = 50, onPage } = {}) =>
      paginate(`segments/${enc(projectKey)}/${enc(envKey)}?limit=${limit}&offset=0`, { onPage }),
    listContextKinds: (projectKey) => get(`projects/${enc(projectKey)}/context-kinds`),
  };
}

const enc = encodeURIComponent;

function headerNum(headers, name) {
  const v = headers?.get?.(name);
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How long to wait after a 429. Uses retry-after / x-ratelimit-reset when exposed, else backoff. */
export function rateLimitWait(headers, attempt) {
  const retryAfter = headerNum(headers, "retry-after");
  if (retryAfter !== null) return Math.max(1000, retryAfter * 1000) + jitter();
  const reset = headerNum(headers, "x-ratelimit-reset");
  if (reset !== null) return Math.max(1000, reset - Date.now()) + jitter();
  return Math.min(30000, 1000 * 2 ** attempt) + jitter();
}

/** Slow down before we hit the limit, when the browser/runtime lets us read the headers. */
async function proactiveWait(headers, sleep, log) {
  const remaining = headerNum(headers, "x-ratelimit-route-remaining");
  const reset = headerNum(headers, "x-ratelimit-reset");
  if (remaining !== null && remaining <= 2 && reset !== null) {
    const wait = Math.max(0, reset - Date.now()) + 100;
    if (wait > 0) {
      log(`route budget nearly exhausted, pausing ${wait}ms`);
      await sleep(wait);
    }
  }
}

const jitter = () => Math.floor(Math.random() * 250);

/** Common LaunchDarkly hosts. */
export const HOSTS = {
  us: "https://app.launchdarkly.com",
  eu: "https://app.eu.launchdarkly.com",
};
