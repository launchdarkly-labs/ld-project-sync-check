import { assertEquals } from "@std/assert";
import { compareFlags, compareSegments } from "../lib/compare.js";
import { summarize, toMarkdown } from "../lib/report.js";
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
  const segments = compareSegments([segmentA], [segmentBIdentical], envMap[0], opts);
  assertEquals(segments[0].status, "identical");
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
