// Compare two LaunchDarkly projects and write report.json + report.md.
//
//   LD_TOKEN_A=api-... LD_TOKEN_B=api-... deno task check \
//     --a-url https://app.launchdarkly.com --b-url https://app.eu.launchdarkly.com \
//     --a-project my-project --env-map "development:development,staging:staging,production:production"
//
// Exit code: 0 pass, 1 fail, 2 warnings only (or 1 with --fail-on warn).

import { HOSTS, makeClient } from "../lib/ld_api.js";
import { compareProjects } from "../lib/compare.js";
import { toMarkdown } from "../lib/report.js";
import { annotateWithManifest, destKeysFromManifest, manifestMismatch, parseManifest, parseRunRecord, runRecordMismatch } from "../lib/manifest.js";
import { loadConfig, parse, parseEnvMap, pick, progressPrinter, stderr, writeOut } from "./_common.js";

const args = parse({
  string: ["a-url", "b-url", "a-project", "b-project", "a-label", "b-label", "env-map", "key-prefix", "out", "config", "fail-on", "token-a", "token-b", "manifest", "run-record"],
  boolean: ["help", "include-archived", "compare-maintainers", "strict-extra", "quiet"],
  default: { out: "out", "fail-on": "error" },
});

if (args.help) {
  console.log(`Usage: deno task check [options]
  --config <file.json>        JSON with the same options in camelCase (aUrl, bUrl, aProject, bProject, envMap, ...)
  --a-url / --b-url           Instance base URLs (default: US / EU)
  --a-project / --b-project   Project keys (b defaults to a)
  --a-label / --b-label       Labels for the report (default: US / EU)
  --env-map a:b,c:d           Environment pairs (default: environments with identical keys on both sides)
  --include-archived          Also compare archived flags
  --compare-maintainers       Compare maintainer emails (info severity)
  --strict-extra              Flags only present in B count as errors
  --key-prefix <p>            Expect B keys to be <p> + A key (conflict-prefix migrations)
  --manifest <file>           Sync manifest from ld-migration-scripts: pairs keys as recorded and labels
                              each difference (waiting for the next sync, changed in B after the last
                              sync, conflict, ...); expected differences become info
  --run-record <file>         Run record of the last migrate run (runs/latest-<src>-<dst>.json): last
                              run details, and environments no longer synced count as cut over
  --out <dir>                 Output directory (default: out)
  --fail-on error|warn        Exit 1 on warnings too
Tokens: LD_TOKEN_A / LD_TOKEN_B environment variables (or tokenA/tokenB in --config).`);
  Deno.exit(0);
}

const cfg = await loadConfig(args.config);
const aUrl = pick(args, cfg, "a-url") ?? cfg.aUrl ?? HOSTS.us;
const bUrl = pick(args, cfg, "b-url") ?? cfg.bUrl ?? HOSTS.eu;
const projectA = pick(args, cfg, "a-project") ?? cfg.aProject;
const projectB = pick(args, cfg, "b-project") ?? cfg.bProject ?? projectA;
const tokenA = args["token-a"] ?? cfg.tokenA ?? Deno.env.get("LD_TOKEN_A");
const tokenB = args["token-b"] ?? cfg.tokenB ?? Deno.env.get("LD_TOKEN_B");
if (!projectA) fail("--a-project is required");
if (!tokenA || !tokenB) fail("LD_TOKEN_A and LD_TOKEN_B are required");

const log = args.quiet ? () => {} : (s) => stderr(`\n${s}\n`);
const clientA = makeClient({ baseUrl: aUrl, token: tokenA, log });
const clientB = makeClient({ baseUrl: bUrl, token: tokenB, log });

const readJson = async (path, what) => {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    fail(`could not read ${what} ${path}: ${err.message}`);
  }
};
const manifestPath = args.manifest ?? cfg.manifest;
const runRecordPath = args["run-record"] ?? cfg.runRecord;
let manifest = null, runRecord = null;
const syncWarnings = [];
try {
  if (manifestPath) {
    const parsed = parseManifest(await readJson(manifestPath, "sync manifest"));
    manifest = parsed.manifest;
    syncWarnings.push(...parsed.warnings);
  }
  if (runRecordPath) {
    const parsed = parseRunRecord(await readJson(runRecordPath, "run record"));
    runRecord = parsed.run;
    syncWarnings.push(...parsed.warnings);
  }
} catch (err) {
  fail(err.message);
}
if (runRecord && !manifest) fail("--run-record needs --manifest");
if (manifest) {
  // A manifest for other projects would pair the wrong keys and relabel real drift as expected
  const mismatch = manifestMismatch(manifest, { projectA, projectB, baseUrlB: bUrl });
  if (mismatch) fail(`${mismatch} Pass the manifest of this migration`);
}
if (runRecord && runRecordMismatch(runRecord, manifest)) {
  // Dropped before its environment mapping can narrow the comparison
  syncWarnings.push(runRecordMismatch(runRecord, manifest));
  runRecord = null;
}

let envMap = parseEnvMap(args["env-map"]) ?? (Array.isArray(cfg.envMap) ? cfg.envMap : parseEnvMap(cfg.envMap));
// The run's mapping is the natural default when a run record is given
if (!envMap && runRecord) envMap = Object.entries(runRecord.envMap).map(([a, b]) => ({ a, b }));
if (!envMap) {
  const [ea, eb] = await Promise.all([clientA.listEnvironments(projectA), clientB.listEnvironments(projectB)]);
  const bKeys = new Set(eb.map((e) => e.key));
  envMap = ea.filter((e) => bKeys.has(e.key)).map((e) => ({ a: e.key, b: e.key }));
  stderr(`No --env-map given; comparing environments present on both sides: ${envMap.map((m) => m.a).join(", ") || "(none)"}\n`);
  if (!envMap.length) fail("No common environments; pass --env-map");
}

let report = await compareProjects({
  clientA, clientB, projectA, projectB, envMap,
  labels: { a: args["a-label"] ?? cfg.aLabel ?? "US", b: args["b-label"] ?? cfg.bLabel ?? "EU" },
  options: {
    includeArchived: args["include-archived"] || cfg.includeArchived,
    compareMaintainers: args["compare-maintainers"] || cfg.compareMaintainers,
    strictExtra: args["strict-extra"] || cfg.strictExtra,
    keyPrefix: args["key-prefix"] ?? cfg.keyPrefix ?? "",
  },
  onProgress: args.quiet ? () => {} : progressPrinter(),
  destKeys: manifest ? destKeysFromManifest(manifest) : null,
});
if (manifest) {
  report = annotateWithManifest(report, manifest, runRecord);
  report.sync.warnings.unshift(...syncWarnings);
}

const stamp = report.generatedAt.replace(/[:.]/g, "-");
const jsonPath = await writeOut(args.out, `report-${stamp}.json`, JSON.stringify(report, null, 2));
const mdPath = await writeOut(args.out, `report-${stamp}.md`, toMarkdown(report));
await writeOut(args.out, "report-latest.json", JSON.stringify(report, null, 2));
await writeOut(args.out, "report-latest.md", toMarkdown(report));

const s = report.summary;
console.log(`\nStatus: ${s.status.toUpperCase()}`);
console.log(`Flags   A ${s.flags.a}  B ${s.flags.b}  identical ${s.flags.identical}  differing ${s.flags.differing}  missing-in-B ${s.flags.missingInB}  extra-in-B ${s.flags.extraInB}`);
for (const [env, g] of Object.entries(s.segments)) {
  console.log(`Segments ${env}: A ${g.a}  B ${g.b}  identical ${g.identical}  differing ${g.differing}  missing-in-B ${g.missingInB}  extra-in-B ${g.extraInB}`);
}
console.log(`Findings: ${s.counts.error} error, ${s.counts.warning} warning, ${s.counts.info} info${report.errors.length ? `; ${report.errors.length} fetch error(s)` : ""}`);
if (report.sync) {
  const c = report.sync.counts.flags;
  console.log(`Sync    last sync ${report.sync.manifest.lastSyncTimestamp ?? "unknown"}; flags: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join("  ") || "none"}`);
  for (const w of report.sync.warnings) console.log(`        ⚠ ${w}`);
}
console.log(`Report: ${mdPath}\n        ${jsonPath}`);

if (s.status === "fail") Deno.exit(1);
if (s.status === "warn") Deno.exit(args["fail-on"] === "warn" ? 1 : 2);

function fail(msg) { console.error(`Error: ${msg} (see --help)`); Deno.exit(64); }
