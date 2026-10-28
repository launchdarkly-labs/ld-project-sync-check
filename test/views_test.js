import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { compareFlags, compareSegments } from "../lib/compare.js";
import { meaningGroups, parseReport, summarize, syncStatusLine, verdictText } from "../lib/report.js";
import { annotateWithManifest, checkSyncInputs } from "../lib/manifest.js";
import { flagA, flagBIdentical, segmentA, segmentBIdentical } from "./fixtures/flags.js";

const envMap = [{ a: "prod", b: "production" }, { a: "dev", b: "development" }];
const opts = { includeArchived: false, compareMaintainers: false, strictExtra: false, keyPrefix: "" };
const clone = (o) => JSON.parse(JSON.stringify(o));

const manifest = () => ({
  lastSyncTimestamp: "2026-10-22T09:00:00.000Z",
  lastRunStartedAt: "2026-10-22T08:55:00.000Z",
  sourceProject: "p",
  destProject: "p",
  destDomain: "app.eu.launchdarkly.com",
  flags: { "checkout-v2": { version: 12, environments: { prod: { version: 40 } }, dest: { version: 1, environments: { production: { version: 2 } } } } },
  segments: { prod: { "beta-users": { version: 3, destEnv: "production", dest: { version: 1 } } } },
});

function reportFor(flagsA, flagsB) {
  const flags = compareFlags({ live: flagsA, archived: [] }, { live: flagsB, archived: [] }, envMap, opts);
  const segments = compareSegments([segmentA], [segmentBIdentical], envMap[0], opts);
  const report = {
    generatedAt: "2026-10-28T12:00:00.000Z", tool: { name: "t", version: "0" },
    sides: { a: { label: "US", baseUrl: "https://app.launchdarkly.com", projectKey: "p", envs: ["prod", "dev"] }, b: { label: "EU", baseUrl: "https://app.eu.launchdarkly.com", projectKey: "p", envs: ["production", "development"] } },
    envMap, options: opts, flags, segments, evaluation: [], errors: [],
  };
  report.summary = summarize(report, { totalA: flagsA.length, totalB: flagsB.length });
  return report;
}

/** B turned production off after the migration (its environment version moved). */
const editedInEu = () => {
  const b = clone(flagBIdentical);
  b.environments.production.on = false;
  b.environments.production.version = 3;
  return b;
};
const extraFlag = () => ({ ...clone(flagBIdentical), key: "eu-only" });

Deno.test("without a manifest every difference is unexpected; a B-only flag is only in B", () => {
  const b = editedInEu();
  const report = reportFor([flagA], [b, extraFlag()]);
  assertEquals(meaningGroups(report).map((g) => [g.id, g.items.map((x) => `${x.key} ${x.where.join(",")}`)]), [
    ["unexpected", ["checkout-v2 prod→production"]],
    ["onlyInB", ["eu-only "]],
  ]);
  assertEquals(verdictText(report), "Out of sync: 1 item with unexpected differences.");
});

Deno.test("with the manifest a B edit is protected, and the verdict passes", () => {
  const report = annotateWithManifest(reportFor([flagA], [editedInEu()]), manifest());
  const groups = meaningGroups(report);
  assertEquals(groups.map((g) => g.id), ["protected"]);
  assertEquals(groups[0].items, [{ kind: "flag", key: "checkout-v2", where: ["prod→production"] }]);
  assertEquals(verdictText(report, groups), "In sync, apart from expected differences (1 item).");
});

Deno.test("a change on both sides is a conflict to look at", () => {
  const a = clone(flagA);
  a.environments.prod._version = 41;
  a.environments.prod.version = 41;
  const report = annotateWithManifest(reportFor([a], [editedInEu()]), manifest());
  assertEquals(meaningGroups(report).map((g) => g.id), ["conflict"]);
  assertEquals(verdictText(report), "Nearly in sync: 1 item to look at.");
});

Deno.test("identical projects read as in sync", () => {
  assertEquals(meaningGroups(reportFor([flagA], [flagBIdentical])), []);
  assertEquals(verdictText(reportFor([flagA], [flagBIdentical])), "In sync: every compared flag and segment matches.");
});

Deno.test("the last-sync line names the run, its mode and what it left as it is", () => {
  const run = { schemaVersion: 1, startedAt: "2026-10-28T12:37:16.387Z", envMap: { prod: "production" }, mode: "dry-run", dryRun: true, toolVersion: "3.6.1", source: { projectKey: "p" }, destination: { projectKey: "p", domain: "app.eu.launchdarkly.com" }, protected: [{ kind: "flag", key: "checkout-v2", scope: "environment", env: "production", sourceChanged: false, extra: "dropped" }] };
  const report = annotateWithManifest(reportFor([flagA], [editedInEu()]), manifest(), run);
  assertEquals(syncStatusLine(report.sync), "Last sync 2026-10-22 09:00Z · 1 flags tracked · 3.6.1 · dry-run 2026-10-28 12:37Z · 1 protected");
  assertEquals(syncStatusLine({ ...report.sync, run: { ...report.sync.run, mode: "incremental", conflicts: 2 } }).endsWith("incremental (dry run) 2026-10-28 12:37Z · 1 protected · 2 conflicts"), true);
  assertEquals(report.sync.run.items, { protected: [{ kind: "flag", key: "checkout-v2", scope: "environment", env: "production", sourceChanged: false }], conflicts: [] });
  assertEquals(syncStatusLine(undefined), "");
});

Deno.test("a shared report round-trips and its status is recomputed", () => {
  const report = annotateWithManifest(reportFor([flagA], [editedInEu()]), manifest());
  const shared = JSON.parse(JSON.stringify(report));
  shared.summary.status = "pass";
  shared.summary.counts = { error: 0, warning: 0, info: 0 };
  const parsed = parseReport(shared);
  assertEquals(parsed.summary, report.summary);
  assertEquals(meaningGroups(parsed), meaningGroups(report));
  // A tampered finding counts as what it says
  shared.flags[0].environments["prod→production"][0].severity = "error";
  assertEquals(parseReport(shared).summary.status, "fail");
});

Deno.test("parseReport rejects other files and non-https links", () => {
  const good = () => JSON.parse(JSON.stringify(reportFor([flagA], [flagBIdentical])));
  assertThrows(() => parseReport({ flags: {} }));
  assertThrows(() => parseReport({ ...good(), sides: { ...good().sides, b: { ...good().sides.b, baseUrl: "javascript:alert(1)" } } }), Error, "sides.b");
  assertThrows(() => parseReport({ ...good(), flags: [{ key: "x", status: "weird", severity: "error" }] }), Error, "flags[0]");
  assertThrows(() => parseReport({ ...good(), generatedAt: "yesterday" }), Error, "generatedAt");
  parseReport(good());
});

Deno.test("checkSyncInputs: refuses another migration's manifest, drops a foreign run record", async () => {
  const base = { projectA: "p", projectB: "p", baseUrlB: "https://app.eu.launchdarkly.com", accountB: () => "acct-1" };
  await assertRejects(() => checkSyncInputs({ ...base, manifestJson: manifest(), projectB: "other" }), Error, "Pass the manifest of this migration");
  await assertRejects(() => checkSyncInputs({ ...base, runRecordJson: { schemaVersion: 1, startedAt: "2026-10-22T08:55:00Z", envMap: {} } }), Error, "needs the sync manifest");
  await assertRejects(() => checkSyncInputs({ ...base, manifestJson: { ...manifest(), destAccountId: "acct-2" } }), Error, "account acct-2");
  const unread = await checkSyncInputs({ ...base, manifestJson: { ...manifest(), destAccountId: "acct-2" }, accountB: () => Promise.reject(new Error("403")) });
  assertEquals(unread.warnings.length, 1);
  const foreign = await checkSyncInputs({ ...base, manifestJson: manifest(), runRecordJson: { schemaVersion: 1, startedAt: "2026-10-22T08:55:00Z", envMap: {}, source: { projectKey: "q" }, destination: { projectKey: "p" } } });
  assertEquals(foreign.runRecord, null);
  assertEquals(foreign.warnings.length, 1);
  const ok = await checkSyncInputs({ ...base, manifestJson: manifest() });
  assertEquals([ok.manifest !== null, ok.runRecord, ok.warnings], [true, null, []]);
});
