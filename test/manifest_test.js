import { assertEquals, assertThrows } from "@std/assert";
import { compareFlags, compareSegments } from "../lib/compare.js";
import { summarize, toMarkdown } from "../lib/report.js";
import { annotateWithManifest, destKeysFromManifest, manifestMismatch, parseManifest, parseRunRecord, runRecordMismatch } from "../lib/manifest.js";
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

Deno.test("parseManifest rejects malformed versions and destination keys", () => {
  assertThrows(() => parseManifest(manifestFor({ environments: { prod: { version: "40" } } })), Error, "flags.checkout-v2.environments.prod.version");
  assertThrows(() => parseManifest(manifestFor({ destKey: 7 })), Error, "flags.checkout-v2.destKey");
  assertThrows(() => parseManifest(manifestFor({ dest: { version: 1, environments: { production: { version: "2" } } } })), Error, "dest.environments.production.version");
  const m = manifestFor();
  m.segments.prod["beta-users"].version = "3";
  assertThrows(() => parseManifest(m), Error, "segments.prod.beta-users.version");
  m.segments.prod["beta-users"].version = 3;
  m.segments.prod["beta-users"].targetOwned = true;
  assertThrows(() => parseManifest(m), Error, "segments.prod.beta-users.targetOwned");
});

Deno.test("entries without destKey pair under their own key, ahead of --key-prefix", () => {
  const keys = destKeysFromManifest(manifestFor());
  assertEquals([keys.flags.get("checkout-v2"), keys.segments.get("prod/beta-users")], ["checkout-v2", "beta-users"]);
  const prefixed = { ...opts, keyPrefix: "mig-" };
  const [r] = compareFlags({ live: [flagA], archived: [] }, { live: [flagBIdentical], archived: [] }, envMap, prefixed, null, keys.flags);
  assertEquals([r.keyB, r.status], ["checkout-v2", "identical"]);
});

Deno.test("a manifest for another project or instance is ignored and leaves findings as they are", () => {
  const report = reportFor(flagA, null);
  for (const m of [{ ...manifestFor(), destProject: "other" }, { ...manifestFor(), destDomain: "app.launchdarkly.com" }]) {
    const out = annotateWithManifest(report, m);
    assertEquals([out.sync.ignored, out.flags[0].severity, out.flags[0].sync, out.summary.status], [true, "error", undefined, report.summary.status]);
    assertEquals(out.sync.warnings.length, 1);
  }
  assertEquals(manifestMismatch(manifestFor(), { projectA: "p", projectB: "p", baseUrlB: "https://app.eu.launchdarkly.com/" }), null);
  assertEquals(manifestMismatch(manifestFor(), { projectA: "p", projectB: "q", baseUrlB: null }) !== null, true);
  const run = { source: { projectKey: "p" }, destination: { projectKey: "elsewhere" } };
  assertEquals(runRecordMismatch(run, manifestFor()) !== null, true);
});

Deno.test("deleted in B and changed in A since is a conflict, for flags and segments", () => {
  const a = clone(flagA);
  a.environments.prod.version = 41;
  let out = annotateWithManifest(reportFor(a, null), manifestFor());
  assertEquals([out.flags[0].sync, out.flags[0].severity], [{ state: "conflict", deleted: true }, "warning"]);
  out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segA: { ...clone(segmentA), version: 4 }, segB: null }), manifestFor());
  assertEquals([out.segments[0].sync, out.segments[0].severity], [{ state: "conflict", deleted: true }, "warning"]);
  out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segB: null }), manifestFor());
  assertEquals([out.segments[0].sync, out.segments[0].severity], [{ state: "editedInTarget", deleted: true }, "info"]);
});

Deno.test("an untracked segment created in A after the last run waits for the sync", () => {
  const fresh = { ...clone(segmentA), key: "new-segment", creationDate: Date.parse("2026-10-23T08:00:00Z") };
  let out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segA: fresh, segB: null }), manifestFor());
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["pendingSource", "info"]);
  const old = { ...clone(segmentA), key: "old-segment" };
  out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segA: old, segB: null }), manifestFor());
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["untracked", "error"]);
});

const runFor = (overrides = {}) => ({
  schemaVersion: 1, startedAt: "2026-10-22T08:55:00.000Z", envMap: { prod: "production", dev: "development" },
  source: { projectKey: "p" }, destination: { projectKey: "p", domain: "app.eu.launchdarkly.com" }, conflicts: [], ...overrides,
});

Deno.test("parseRunRecord rejects malformed environment mappings and resource lists", () => {
  assertThrows(() => parseRunRecord(runFor({ envMap: { prod: 42 } })), Error, "envMap.prod");
  assertThrows(() => parseRunRecord(runFor({ conflicts: [{ kind: "flag" }] })), Error, "conflicts");
  assertEquals(parseRunRecord(runFor()).warnings, []);
});

Deno.test("a run record for another destination instance is ignored", () => {
  const run = runFor({ destination: { projectKey: "p", domain: "app.launchdarkly.com" } });
  assertEquals(runRecordMismatch(run, manifestFor()) !== null, true);
  const out = annotateWithManifest(reportFor(flagA, offInEu()), manifestFor(), run);
  assertEquals([out.sync.run, out.sync.cutOver, out.sync.warnings.length], [null, [], 1]);
});

Deno.test("conflicts of the last run stay conflicts though the manifest has the new source version", () => {
  // migrate left production alone (edited in EU) and recorded A's current version anyway
  const b = offInEu();
  b.environments.production.version = 3;
  const run = runFor({ conflicts: [{ kind: "flag", key: "checkout-v2", destKey: "checkout-v2", scope: "environment", env: "production", sourceChanged: true }] });
  let out = annotateWithManifest(reportFor(flagA, b), manifestFor());
  assertEquals(out.flags[0].sync.environments["prod→production"], "editedInTarget");
  out = annotateWithManifest(reportFor(flagA, b), manifestFor(), run);
  assertEquals([out.flags[0].sync.environments["prod→production"], out.flags[0].severity], ["conflict", "warning"]);
  const segB = { ...clone(segmentBIdentical), description: "edited in EU", version: 2 };
  const segRun = runFor({ conflicts: [{ kind: "segment", key: "beta-users", destKey: "beta-users", scope: "environment", env: "production", sourceChanged: true }] });
  out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segB }), manifestFor(), segRun);
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["conflict", "warning"]);
});

Deno.test("a segment recorded for another destination environment has no baseline here", () => {
  const m = manifestFor();
  m.segments.prod["beta-users"].destEnv = "old-production";
  const segB = { ...clone(segmentBIdentical), description: "differs", version: 2 };
  const out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segB }), m);
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["untracked", "error"]);
});

Deno.test("a dry run's record neither selects environments nor cuts any over", () => {
  for (const run of [runFor({ dryRun: true, envMap: { dev: "development" } }), runFor({ manifestWritten: false, envMap: { dev: "development" } })]) {
    assertEquals(parseRunRecord(run).warnings.length, 1);
    const out = annotateWithManifest(reportFor(flagA, offInEu()), manifestFor(), run);
    assertEquals([out.sync.cutOver, out.flags[0].sync.environments["prod→production"], out.flags[0].severity], [[], "inSync", "error"]);
  }
});

Deno.test("entries whose last sync failed (source version reset to 0) keep their findings", () => {
  const b = offInEu();
  b.environments.production.version = 3;
  let out = annotateWithManifest(reportFor(flagA, b), manifestFor({ version: 0, environments: {} }));
  assertEquals([out.flags[0].sync.state, out.flags[0].severity], ["untracked", "error"]);
  const m = manifestFor();
  m.segments.prod["beta-users"].version = 0;
  const segB = { ...clone(segmentBIdentical), description: "differs", version: 2 };
  out = annotateWithManifest(reportFor(flagA, flagBIdentical, { segB }), m);
  assertEquals([out.segments[0].sync.state, out.segments[0].severity], ["untracked", "error"]);
});

Deno.test("an environment owned by B protects the flag level even when it is not compared", () => {
  const narrow = [envMap[1]];
  const a = { ...clone(flagA), version: 13, description: "changed in US" };
  const flags = compareFlags({ live: [a], archived: [] }, { live: [flagBIdentical], archived: [] }, narrow, opts);
  const report = { ...reportFor(flagA, flagBIdentical), envMap: narrow, flags };
  const out = annotateWithManifest(report, manifestFor({ targetOwned: { environments: ["production"] } }));
  assertEquals([out.flags[0].sync.flagLevel, out.flags[0].severity], ["conflict", "warning"]);
});

Deno.test("a run record from another run than the manifest's last one is ignored", () => {
  const old = runFor({ startedAt: "2026-10-20T08:00:00.000Z", envMap: { dev: "development" } });
  assertEquals(runRecordMismatch(old, manifestFor()) !== null, true);
  assertEquals(runRecordMismatch(runFor(), manifestFor()), null);
  // A dry run after the last real run is fine; its mapping is not used anyway
  assertEquals(runRecordMismatch({ ...old, dryRun: true }, manifestFor()), null);
});

Deno.test("a copy deleted and recreated in B is B's everywhere", () => {
  const out = annotateWithManifest(reportFor(flagA, offInEu()), manifestFor({ targetOwned: { deleted: true } }));
  assertEquals([out.flags[0].sync.state, out.flags[0].severity], ["editedInTarget", "info"]);
});

Deno.test("legacy entries use legacyEditCutoff when the manifest has one", () => {
  const legacy = manifestFor();
  delete legacy.flags["checkout-v2"].dest;
  legacy.legacyEditCutoff = "2026-10-20T09:00:00.000Z";
  const b = offInEu();
  // Edited in B before the last sync on this version but after the last legacy run
  b.environments.production.lastModified = Date.parse("2026-10-21T10:00:00Z");
  assertEquals(annotateWithManifest(reportFor(flagA, b), legacy).flags[0].sync.state, "editedInTarget");
});

Deno.test("conflicts of a dry run's record are not taken as source changes", () => {
  const b = offInEu();
  b.environments.production.version = 3;
  const conflicts = [{ kind: "flag", key: "checkout-v2", destKey: "checkout-v2", scope: "environment", env: "production", sourceChanged: true }];
  const out = annotateWithManifest(reportFor(flagA, b), manifestFor(), runFor({ dryRun: true, startedAt: "2026-10-23T08:00:00.000Z", conflicts }));
  assertEquals(out.flags[0].sync.environments["prod→production"], "editedInTarget");
});

Deno.test("a copy migrate could not read back is judged against its own dest.since", () => {
  const m = manifestFor({ dest: { since: Date.parse("2026-10-23T09:00:00Z") } });
  const b = offInEu();
  // Modified after the last sync but before the run's own write: not an edit in B
  b.environments.production.lastModified = Date.parse("2026-10-23T08:00:00Z");
  assertEquals(annotateWithManifest(reportFor(flagA, b), m).flags[0].sync.environments["prod→production"], "inSync");
  b.environments.production.lastModified = Date.parse("2026-10-23T10:00:00Z");
  assertEquals(annotateWithManifest(reportFor(flagA, b), m).flags[0].sync.environments["prod→production"], "editedInTarget");
  const seg = manifestFor();
  seg.segments.prod["beta-users"].dest = { since: Date.parse("2026-10-23T09:00:00Z") };
  const segB = { ...clone(segmentBIdentical), description: "differs", lastModifiedDate: Date.parse("2026-10-23T08:00:00Z") };
  assertEquals(annotateWithManifest(reportFor(flagA, flagBIdentical, { segB }), seg).segments[0].sync.state, "inSync");
  assertThrows(() => parseManifest(manifestFor({ dest: { since: "x" } })), Error, "dest.since");
});

Deno.test("an environment the manifest never synced for the flag keeps its findings", () => {
  const b = clone(flagBIdentical);
  b.environments.development.on = !b.environments.development.on;
  let out = annotateWithManifest(reportFor(flagA, b), manifestFor());
  assertEquals([out.flags[0].sync.environments["dev→development"], out.flags[0].severity], ["untracked", "error"]);
  // and a deleted copy is no conflict just because dev has no recorded version
  out = annotateWithManifest(reportFor(flagA, null), manifestFor());
  assertEquals(out.flags[0].sync.state, "editedInTarget");
});

Deno.test("an edit in a cut-over environment keeps the flag level as it is", () => {
  const run = runFor({ envMap: { dev: "development" } });
  const a = { ...clone(flagA), version: 13, description: "changed in US" };
  const b = offInEu();
  b.environments.production.version = 3;
  const flags = compareFlags({ live: [a], archived: [] }, { live: [b], archived: [] }, envMap, opts);
  const out = annotateWithManifest({ ...reportFor(flagA, b), flags }, manifestFor(), run);
  assertEquals([out.flags[0].sync.environments["prod→production"], out.flags[0].sync.flagLevel], ["cutOver", "conflict"]);
});

Deno.test("B's ownership applies to environments the manifest has no source version for", () => {
  const b = clone(flagBIdentical);
  b.environments.development.on = !b.environments.development.on;
  const out = annotateWithManifest(reportFor(flagA, b), manifestFor({ targetOwned: { deleted: true } }));
  assertEquals([out.flags[0].sync.environments["dev→development"], out.flags[0].severity], ["editedInTarget", "info"]);
});
