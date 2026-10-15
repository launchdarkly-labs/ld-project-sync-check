// Compare two server-side SDK polling payloads (GET {sdkBase}/sdk/latest-all).
// This is "what the SDKs actually receive", the strongest parity signal for a cutover.
// Noise lists mirror ld-migration-scripts/src/scripts/diff-payload/mod.ts.

import { diff } from "./deep_diff.js";

const RECURSIVE_NOISE = new Set(["_id", "id"]);
const FLAG_NOISE = new Set(["version", "flagVersion", "debugEventsUntilDate", "salt", "sel"]);
const SEGMENT_NOISE = new Set(["version", "generation", "salt"]);

function deepClean(value) {
  if (Array.isArray(value)) return value.map(deepClean);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!RECURSIVE_NOISE.has(k)) out[k] = deepClean(v);
    return out;
  }
  return value;
}

function cleanEntries(entries, noise) {
  const out = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    const e = {};
    for (const [k, v] of Object.entries(entry ?? {})) if (!noise.has(k) && !RECURSIVE_NOISE.has(k)) e[k] = deepClean(v);
    out[key] = e;
  }
  return out;
}

export async function fetchSdkPayload(sdkKey, baseUrl = "https://sdk.launchdarkly.com", fetchImpl = globalThis.fetch) {
  const url = `${baseUrl.replace(/\/+$/, "")}/sdk/latest-all`;
  const res = await fetchImpl(url, { headers: { Authorization: sdkKey } });
  if (!res.ok) throw new Error(`SDK poll failed: HTTP ${res.status} for ${url}: ${await res.text().catch(() => "")}`);
  return await res.json();
}

/** Returns { flags: {identical, changed, onlyInA, onlyInB, entries[]}, segments: {...} } */
export function diffSdkPayloads(a, b) {
  const section = (ea, eb, noise) => {
    const ca = cleanEntries(ea, noise);
    const cb = cleanEntries(eb, noise);
    const keys = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort();
    const res = { identical: 0, changed: 0, onlyInA: [], onlyInB: [], entries: [] };
    for (const k of keys) {
      if (!(k in cb)) { res.onlyInA.push(k); continue; }
      if (!(k in ca)) { res.onlyInB.push(k); continue; }
      const d = diff(ca[k], cb[k]);
      if (d.length) { res.changed++; res.entries.push({ key: k, diffs: d }); } else res.identical++;
    }
    return res;
  };
  return { flags: section(a.flags, b.flags, FLAG_NOISE), segments: section(a.segments, b.segments, SEGMENT_NOISE) };
}

export function sdkDiffToMarkdown(result, meta) {
  const L = [`# SDK payload comparison: ${meta.envA} (${meta.baseA}) vs ${meta.envB} (${meta.baseB})`, ""];
  for (const [name, s] of Object.entries(result)) {
    const ok = s.changed === 0 && s.onlyInA.length === 0 && s.onlyInB.length === 0;
    L.push(`## ${name}: ${ok ? "✅ identical" : "❌ differences"}`, "");
    L.push(`- identical ${s.identical}, changed ${s.changed}, only in A ${s.onlyInA.length}, only in B ${s.onlyInB.length}`, "");
    for (const k of s.onlyInA) L.push(`- only in A: \`${k}\``);
    for (const k of s.onlyInB) L.push(`- only in B: \`${k}\``);
    for (const e of s.entries) {
      L.push(`- \`${e.key}\`:`);
      for (const d of e.diffs) L.push(`  - ${d.path}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`);
    }
    L.push("");
  }
  return L.join("\n");
}
