import { assertEquals, assertThrows } from "@std/assert";
import { compareFlags, compareSegments } from "../lib/compare.js";
import { summarize, toMarkdown } from "../lib/report.js";
import { annotateWithManifest, destKeysFromManifest, parseManifest, parseRunRecord } from "../lib/manifest.js";
import { flagA, flagBIdentical, segmentA, segmentBIdentical } from "./fixtures/flags.js";

const envMap = [{ a: "prod", b: "production" }, { a: "dev", b: "development" }];
const opts = { includeArchived: false, compareMaintainers: false, strictExtra: false, keyPrefix: "" };
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Manifest as migrate leaves it right after syncing flagA into flagBIdentical (A prod v40, B production v2). */
const manifestFor = (overrides = {}) => ({
  lastSyncTimestamp: "2026-10-22T09:00:00.000Z",
  lastRunStartedAt: "2026-10-22T08:55:00.000Z",
  sourceProject: "p",
  destProject: "p",
  destDomain: "app.eu.launchdarkly.com",
  flags: {
    "checkout-v2": {
      version: 12,
      environments: { prod: { version: 40 } },
      dest: { version: 1, environments: { production: { version: 2 } } },
      ...overrides,
    },
  },
  segments: { prod: { "beta-users": { version: 3, destEnv: "production", dest: { version: 1 } } } },
});

function reportFor(a, b, { segA = segmentA, segB = segmentBIdentical } = {}) {
  const flags = compareFlags({ live: a ? [a] : [], archived: [] }, { live: b ? [b] : [], archived: [] }, envMap, opts);
  const segments = compareSegments([segA], segB ? [segB] : [], envMap[0], opts);
  const report = {
    generatedAt: "now", tool: { name: "t", version: "0" },
    sides: { a: { label: "US", baseUrl: "https://app.launchdarkly.com", projectKey: "p", envs: ["prod", "dev"] }, b: { label: "EU", baseUrl: "https://app.eu.launchdarkly.com", projectKey: "p", envs: ["production", "development"] } },
    envMap, options: opts, flags, segments, evaluation: [], errors: [],
  };
  report.summary = summarize(report, { totalA: 1, totalB: 1 });
  return report;
}

const offInEu = () => {
  const b = clone(flagBIdentical);
  b.environments.production.on = false;
  return b;
};

Deno.test("parseManifest and parseRunRecord reject other files and warn on gaps", () => {
  assertThrows(() => parseManifest({ items: [] }));
  assertThrows(() => parseRunRecord({ flags: {} }));
  const legacy = manifestFor();
  delete legacy.flags["checkout-v2"].dest;
  assertEquals(parseManifest(legacy).warnings.length, 1);
  assertEquals(parseManifest(manifestFor()).warnings, []);
  assertEquals(parseRunRecord({ schemaVersion: 9, startedAt: "x", envMap: {}, dryRun: true }).warnings.length, 2);
});

Deno.test("a difference with both sides unchanged since the last sync stays an error", () => {
  const report = reportFor(flagA, offInEu());
  // B's version did not move (as if the difference came from the migration itself)
  const out = annotateWithManifest(report, manifestFor());
  const [f] = out.flags;
  assertEquals(f.sync.state, "inSync");
  assertEquals(f.severity, "error");
  assertEquals(out.summary.status, "fail");
});

Deno.test("a change in B after the last sync is editedInTarget and info", () => {
  const b = offInEu();
  b.environments.production.version = 3;
  const out = annotateWithManifest(reportFor(flagA, b), manifestFor());
  const [f] = out.flags;
  assertEquals(f.sync.environments["prod→production"], "editedInTarget");
  assertEquals(f.sync.state, "editedInTarget");
  assertEquals(f.environments["prod→production"].every((e) => e.severity === "info"), true);
  assertEquals(f.severity, "info");
  assertEquals(out.summary.status, "pass");
  assertEquals(out.sync.counts.flags, { editedInTarget: 1 });
});

Deno.test("a change in A after the last sync is pendingSource; both is a conflict (warning)", () => {
  const a = clone(flagA);
  a.environments.prod.on = false;
  a.environments.prod.version = 41;
  let out = annotateWithManifest(reportFor(a, flagBIdentical), manifestFor());
  assertEquals(out.flags[0].sync.state, "pendingSource");
  assertEquals(out.summary.status, "pass");
  const b = clone(flagBIdentical);
  b.environments.production.rules[0].clauses[0].values = ["DE"];
  b.environments.production.version = 3;
  out = annotateWithManifest(reportFor(a, b), manifestFor());
  assertEquals(out.flags[0].sync.state, "conflict");
  assertEquals(out.flags[0].severity, "warning");
  assertEquals(out.summary.status, "warn");
});

Deno.test("parts the migration marked targetOwned stay editedInTarget", () => {
  const out = annotateWithManifest(reportFor(flagA, offInEu()), manifestFor({ targetOwned: { environments: ["production"] } }));
  assertEquals(out.flags[0].sync.state, "editedInTarget");
});

Deno.test("legacy entries fall back to B's last change against the last sync", () => {
  const legacy = manifestFor();
  delete legacy.flags["checkout-v2"].dest;
  const b = offInEu();
  b.environments.production.lastModified = Date.parse("2026-10-23T10:00:00Z");
  assertEquals(annotateWithManifest(reportFor(flagA, b), legacy).flags[0].sync.state, "editedInTarget");
  b.environments.production.lastModified = Date.parse("2026-10-21T10:00:00Z");
  assertEquals(annotateWithManifest(reportFor(flagA, b), legacy).flags[0].sync.state, "inSync");
});

Deno.test("a recorded flag missing in B was deleted there; an untracked new A flag waits for the sync", () => {
  let out = annotateWithManifest(reportFor(flagA, null), manifestFor());
  assertEquals([out.flags[0].sync, out.flags[0].severity], [{ state: "editedInTarget", deleted: true }, "info"]);
  const fresh = { ...clone(flagA), key: "brand-new", creationDate: Date.parse("2026-10-23T08:00:00Z") };
  out = annotateWithManifest(reportFor(fresh, null), manifestFor());
  assertEquals([out.flags[0].sync.state, out.flags[0].severity], ["pendingSource", "info"]);
  const old = { ...clone(flagA), key: "never-migrated", creationDate: Date.parse("2026-01-01T00:00:00Z") };
  out = annotateWithManifest(reportFor(old, null), manifestFor());
  assertEquals([out.flags[0].sync.state, out.flags[0].severity], ["untracked", "error"]);
});

Deno.test("environments missing from the last run's mapping are cut over", () => {
  const run = { schemaVersion: 1, startedAt: "2026-10-22T08:55:00Z", envMap: { dev: "development" }, source: { projectKey: "p" }, destination: { projectKey: "p" } };
  const out = annotateWithManifest(reportFor(flagA, offInEu()), manifestFor(), run);
  assertEquals(out.sync.cutOver, [{ a: "prod", b: "production" }]);
  assertEquals(out.flags[0].sync.environments["prod→production"], "cutOver");
  assertEquals(out.summary.status, "pass");
});

Deno.test("segments: B change after the last sync is editedInTarget", () => {
  const segB = { ...clone(segmentBIdentical), description: "edited in EU", version: 2 };
  const out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segB }), manifestFor());
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["editedInTarget", "info"]);
});

Deno.test("destination keys from the manifest pair renamed copies", () => {
  const m = manifestFor({ destKey: "mig-checkout-v2" });
  m.segments.prod["beta-users"].destKey = "mig-beta-users";
  const keys = destKeysFromManifest(m);
  const b = { ...clone(flagBIdentical), key: "mig-checkout-v2" };
  const [r] = compareFlags({ live: [flagA], archived: [] }, { live: [b], archived: [] }, envMap, opts, null, keys.flags);
  assertEquals([r.keyB, r.status], ["mig-checkout-v2", "identical"]);
  const [s] = compareSegments([segmentA], [{ ...clone(segmentBIdentical), key: "mig-beta-users" }], envMap[0], opts, keys.segments);
  assertEquals([s.keyB, s.status], ["mig-beta-users", "identical"]);
});

Deno.test("markdown has a sync state section and the input report is untouched", () => {
  const b = offInEu();
  b.environments.production.version = 3;
  const report = reportFor(flagA, b);
  const before = JSON.stringify(report);
  const md = toMarkdown(annotateWithManifest(report, manifestFor()));
  assertEquals(JSON.stringify(report), before);
  assertEquals(md.includes("## Sync state"), true);
  assertEquals(md.includes("**Changed in B after the last sync (left as it is by the migration)**: `checkout-v2`"), true);
});
