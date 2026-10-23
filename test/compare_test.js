import { assertEquals } from "@std/assert";
import { compareFlags, compareSegments, missingSegmentRules, sourceTimes } from "../lib/compare.js";
import { listFindings, summarize, toMarkdown } from "../lib/report.js";
import { flagA, flagBIdentical, segmentA, segmentBIdentical } from "./fixtures/flags.js";

const envMap = [{ a: "prod", b: "production" }, { a: "dev", b: "development" }];
const opts = { includeArchived: false, compareMaintainers: false, strictExtra: false, keyPrefix: "" };
const clone = (o) => JSON.parse(JSON.stringify(o));

Deno.test("identical migrated flag has no diffs", () => {
  const [r] = compareFlags({ live: [flagA], archived: [] }, { live: [flagBIdentical], archived: [] }, envMap, opts);
  assertEquals(r.status, "identical");
  assertEquals(r.severity, "none");
  assertEquals(r.flagLevel, []);
  assertEquals(r.environments["prod→production"], []);
});

Deno.test("one changed clause value is one error at the right path", () => {
  const b = clone(flagBIdentical);
  b.environments.production.rules[0].clauses[0].values = ["DE", "CH"];
  const [r] = compareFlags({ live: [flagA], archived: [] }, { live: [b], archived: [] }, envMap, opts);
  assertEquals(r.status, "differs");
  assertEquals(r.environments["prod→production"].map((d) => [d.path, d.severity]), [["rules[0].clauses[0].values[1]", "error"]]);
});

Deno.test("flag-level warning does not fail, rule ref is a warning", () => {
  const b = clone(flagBIdentical);
  b.environments.production.rules[0].ref = "dach-rule";
  const [r] = compareFlags({ live: [flagA], archived: [] }, { live: [b], archived: [] }, envMap, opts);
  assertEquals(r.severity, "warning");
  assertEquals(r.status, "differs");
});

Deno.test("maintainer differences are ignored unless requested", () => {
  const b = clone(flagBIdentical);
  b._maintainer.email = "someone-else@example.com";
  let [r] = compareFlags({ live: [flagA], archived: [] }, { live: [b], archived: [] }, envMap, opts);
  assertEquals(r.status, "identical");
  [r] = compareFlags({ live: [flagA], archived: [] }, { live: [b], archived: [] }, envMap, { ...opts, compareMaintainers: true });
  assertEquals(r.flagLevel.map((d) => [d.path, d.severity]), [["maintainerEmail", "info"]]);
  assertEquals(r.status, "identical");
  assertEquals(r.severity, "info");
});

Deno.test("missing and extra flags, summary status and markdown", () => {
  const extra = { ...clone(flagBIdentical), key: "only-in-eu" };
  const results = compareFlags({ live: [flagA, { ...clone(flagA), key: "gone" }], archived: [] }, { live: [flagBIdentical, extra], archived: [] }, envMap, opts);
  assertEquals(results.map((r) => [r.key, r.status]), [["gone", "missingInB"], ["only-in-eu", "extraInB"], ["checkout-v2", "identical"]]);
  const segments = compareSegments([{ ...segmentA, lastModifiedDate: Date.UTC(2026, 9, 20) }], [{ ...segmentBIdentical, lastModifiedDate: Date.UTC(2026, 9, 22) }], envMap[0], opts);
  assertEquals(segments[0].status, "identical");
  assertEquals([segments[0].createdA, segments[0].updatedA, segments[0].updatedB], ["1970-01-01T00:00:00.001Z", "2026-10-20T00:00:00.000Z", "2026-10-22T00:00:00.000Z"]);
  const report = {
    generatedAt: "now", tool: { name: "t", version: "0" },
    sides: { a: { label: "US", baseUrl: "https://app.launchdarkly.com", projectKey: "p", envs: ["prod", "dev"] }, b: { label: "EU", baseUrl: "https://app.eu.launchdarkly.com", projectKey: "p", envs: ["production", "development"] } },
    envMap, options: opts, flags: results, segments, evaluation: [], errors: [],
  };
  report.summary = summarize(report, { totalA: 2, totalB: 2 });
  assertEquals(report.summary.status, "fail");
  assertEquals(report.summary.flags, { a: 2, b: 2, identical: 1, differing: 0, missingInB: 1, extraInB: 1, archivedA: 0, archivedB: 0 });
  const md = toMarkdown(report);
  assertEquals(md.includes("## Flags missing in B"), true);
  assertEquals(md.includes("`gone`"), true);
  report.flags = results.filter((r) => r.status === "identical");
  report.summary = summarize(report, { totalA: 1, totalB: 1 });
  assertEquals(report.summary.status, "pass");
});

Deno.test("source-side created/updated timestamps and lifecycle state", () => {
  const a = clone(flagA);
  a.environments.dev.lastModified = 1700000005000;
  a.deprecated = true;
  const extra = { ...clone(flagBIdentical), key: "only-in-eu", deprecated: true };
  const b = clone(flagBIdentical);
  b.environments.development.lastModified = 1700000009000;
  b.environments.unmapped = { lastModified: 1800000000000 };
  const results = compareFlags({ live: [a], archived: [] }, { live: [b], archived: [extra] }, envMap, opts);
  const r = results.find((x) => x.key === "checkout-v2");
  assertEquals(r.createdA, new Date(1700000000000).toISOString());
  assertEquals(r.updatedA, new Date(1700000005000).toISOString()); // max over compared envs
  assertEquals(r.updatedB, new Date(1700000009000).toISOString()); // max over mapped B envs only
  assertEquals([r.deprecated, r.archived, r.archivedB], [true, false, false]);
  const x = results.find((y) => y.key === "only-in-eu");
  assertEquals([x.createdA, x.updatedA, x.deprecated, x.archived], [null, null, true, true]);
  // Only the mapped environments count toward "updated".
  assertEquals(sourceTimes(a, ["prod"]).updatedA, new Date(1700000001000).toISOString());
  assertEquals(sourceTimes({ environments: {} }, ["prod"]), { createdA: null, updatedA: null });
});

Deno.test("markdown lists missing flags with source timestamps", () => {
  const gone = { ...clone(flagA), key: "gone", creationDate: Date.UTC(2026, 9, 16, 9, 12) };
  const results = compareFlags({ live: [gone], archived: [] }, { live: [], archived: [] }, envMap, opts);
  const report = {
    generatedAt: "now", tool: { name: "t", version: "0" },
    sides: { a: { label: "US", baseUrl: "u", projectKey: "p", envs: ["prod", "dev"] }, b: { label: "EU", baseUrl: "e", projectKey: "p", envs: ["production", "development"] } },
    envMap, options: opts, flags: results, segments: [], evaluation: [], errors: [],
  };
  report.summary = summarize(report, { totalA: 1, totalB: 0 });
  const md = toMarkdown(report);
  assertEquals(md.includes("- `gone` — created 2026-10-16 09:12Z, updated 2023-11-14 22:13Z"), true);
});

Deno.test("rules referencing segments deleted from A: dead ones are info, live ones stay errors", () => {
  const segRule = (description, clause) => ({ _id: description, description, variation: 0, trackEvents: false, clauses: [{ attribute: "segmentMatch", op: "segmentMatch", ...clause }] });
  const withRules = (f, envKey, rules) => {
    const c = clone(f);
    c.environments[envKey].rules.push(...rules);
    return c;
  };
  const segKeys = new Map([["prod", new Set(["existing"])], ["dev", new Set()]]);
  // Dead: non-negated, only missing segments. B (correctly) lacks it.
  const aDead = withRules(flagA, "prod", [segRule("gone-seg", { values: ["deleted"] })]);
  let [r] = compareFlags({ live: [aDead], archived: [] }, { live: [flagBIdentical], archived: [] }, envMap, opts, segKeys);
  assertEquals([r.status, r.severity, r.droppedRules], ["identical", "info", 1]);
  assertEquals(r.environments["prod→production"].map((d) => [d.path, d.kind, d.severity]), [["rules[2]", "droppedInB", "info"]]);
  assertEquals(r.notes.some((n) => n.includes('"deleted"') && n.includes("does not change evaluation")), true);
  // Without segment info the old behaviour stays: a rules mismatch error.
  [r] = compareFlags({ live: [aDead], archived: [] }, { live: [flagBIdentical], archived: [] }, envMap, opts);
  assertEquals(r.severity, "error");
  // Live: negated clause, or OR'd with an existing segment. Still an error, with an explanation.
  const aLive = withRules(flagA, "prod", [segRule("neg", { values: ["deleted"], negate: true }), segRule("mixed", { values: ["deleted", "existing"] })]);
  [r] = compareFlags({ live: [aLive], archived: [] }, { live: [flagBIdentical], archived: [] }, envMap, opts, segKeys);
  assertEquals([r.status, r.severity, r.droppedRules], ["differs", "error", 0]);
  assertEquals(r.notes.filter((n) => n.includes("still live")).length, 2);
  // If B somehow kept the rule, nothing is reported.
  const bKept = withRules(flagBIdentical, "production", [segRule("gone-seg", { values: ["deleted"] })]);
  [r] = compareFlags({ live: [aDead], archived: [] }, { live: [bKept], archived: [] }, envMap, opts, segKeys);
  assertEquals([r.status, r.severity, r.droppedRules], ["identical", "none", 0]);
});

Deno.test("missingSegmentRules classifies dead and live rules", () => {
  const keys = new Set(["ok"]);
  const rules = [
    { clauses: [{ op: "in", attribute: "country", values: ["DE"] }] },
    { description: "dead", clauses: [{ op: "segmentMatch", values: ["x", "y"] }] },
    { description: "and-dead", clauses: [{ op: "segmentMatch", values: ["x"], negate: true }, { op: "segmentMatch", values: ["x"] }] },
    { description: "or-live", clauses: [{ op: "segmentMatch", values: ["x", "ok"] }] },
  ];
  assertEquals(missingSegmentRules(rules, keys).map((r) => [r.index, r.dead, r.missing]), [[1, true, ["x", "y"]], [2, true, ["x"]], [3, false, ["x"]]]);
});

Deno.test("dropped dead rule is recognized even when a surviving rule also differs", () => {
  const a = clone(flagA);
  a.environments.prod.rules.push({ _id: "d", description: "gone", variation: 0, clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["deleted"] }] });
  const b = clone(flagBIdentical);
  b.environments.production.rules[0].ref = "dach-rule"; // warning-level change on a surviving rule
  const segKeys = new Map([["prod", new Set()], ["dev", new Set()]]);
  const [r] = compareFlags({ live: [a], archived: [] }, { live: [b], archived: [] }, envMap, opts, segKeys);
  assertEquals(r.droppedRules, 1);
  assertEquals(r.environments["prod→production"].map((d) => [d.path, d.severity]), [["rules[2]", "info"], ["rules[0].ref", "warning"]]);
  assertEquals([r.status, r.severity], ["differs", "warning"]);
});

Deno.test("negated clause mixing missing and existing segments is explained precisely", () => {
  const rules = [
    { clauses: [{ op: "segmentMatch", values: ["gone"], negate: true }] },
    { clauses: [{ op: "segmentMatch", values: ["gone", "ok"], negate: true }] },
  ];
  const [all, mixed] = missingSegmentRules(rules, new Set(["ok"]));
  assertEquals([all.dead, mixed.dead], [false, false]);
  assertEquals(all.why.includes("matches every context"), true);
  assertEquals(mixed.why.includes("outside the existing ones"), true);
});

Deno.test("listFindings has one entry per counted finding", () => {
  const b = clone(flagBIdentical);
  b.environments.production.rules[0].clauses[0].values = ["DE", "CH"];
  b.environments.production.rules[0].ref = "dach-rule";
  const results = compareFlags({ live: [flagA, { ...clone(flagA), key: "gone" }], archived: [] }, { live: [b], archived: [] }, envMap, opts);
  const report = { flags: results, segments: [], errors: [] };
  const findings = listFindings(report);
  const counts = summarize(report).counts;
  for (const sev of ["error", "warning", "info"]) assertEquals(findings.filter((x) => x.severity === sev).length, counts[sev]);
  assertEquals(findings.find((x) => x.key === "gone"), { severity: "error", kind: "flag", key: "gone", where: "", message: "missing in B" });
  assertEquals(findings.some((x) => x.key === "checkout-v2" && x.where === "prod→production" && x.path === "rules[0].clauses[0].values[1]"), true);
});
