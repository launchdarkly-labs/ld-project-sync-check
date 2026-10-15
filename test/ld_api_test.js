import { assertEquals } from "@std/assert";
import { makeClient } from "../lib/ld_api.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

Deno.test("paginate follows _links.next and sends auth + api version", async () => {
  const calls = [];
  const fetch = (url, init) => {
    calls.push([url, init.headers]);
    if (url.includes("offset=2")) return Promise.resolve(json({ items: [{ key: "c" }], totalCount: 3 }));
    return Promise.resolve(json({ items: [{ key: "a" }, { key: "b" }], totalCount: 3, _links: { next: { href: "/api/v2/flags/p?limit=2&offset=2" } } }));
  };
  const c = makeClient({ baseUrl: "https://app.launchdarkly.com/", token: "api-x", fetch });
  const items = await c.paginate("flags/p?limit=2&offset=0");
  assertEquals(items.map((i) => i.key), ["a", "b", "c"]);
  assertEquals(calls[0][0], "https://app.launchdarkly.com/api/v2/flags/p?limit=2&offset=0");
  assertEquals(calls[1][0], "https://app.launchdarkly.com/api/v2/flags/p?limit=2&offset=2");
  assertEquals(calls[0][1].Authorization, "api-x");
  assertEquals(calls[0][1]["LD-API-Version"], "20240415");
});

Deno.test("429 then 5xx then success is retried; sleep is injected", async () => {
  let n = 0;
  const waits = [];
  const fetch = () => {
    n++;
    if (n === 1) return Promise.resolve(json({}, 429, { "retry-after": "1" }));
    if (n === 2) return Promise.resolve(json({}, 503));
    if (n === 3) return Promise.reject(new TypeError("network down"));
    return Promise.resolve(json({ ok: true }));
  };
  const c = makeClient({ baseUrl: "https://x", token: "t", fetch, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
  const body = await c.get("caller-identity");
  assertEquals(body, { ok: true });
  assertEquals(n, 4);
  assertEquals(waits.length, 3);
  assertEquals(waits[0] >= 1000, true);
});

Deno.test("non-retryable error throws ApiError with status and body", async () => {
  const fetch = () => Promise.resolve(new Response("nope", { status: 403 }));
  const c = makeClient({ baseUrl: "https://x", token: "t", fetch });
  let err;
  try { await c.get("projects/p"); } catch (e) { err = e; }
  assertEquals(err.name, "ApiError");
  assertEquals(err.status, 403);
  assertEquals(err.body, "nope");
});

Deno.test("listFlags builds env filter and archived filter", async () => {
  const urls = [];
  const fetch = (url) => { urls.push(url); return Promise.resolve(json({ items: [] })); };
  const c = makeClient({ baseUrl: "https://x", token: "t", fetch });
  await c.listFlags("p", { envs: ["a", "b"], archived: true, limit: 10 });
  assertEquals(urls[0], "https://x/api/v2/flags/p?summary=false&limit=10&offset=0&env=a&env=b&filter=state%3Aarchived");
});
