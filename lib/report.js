// Summaries and Markdown rendering for a Report produced by compare.js.

/**
 * Every finding behind the severity counts, one entry per missing/extra item or differing field:
 * { severity, kind: "flag"|"segment", key, where, path?, a?, b?, message? }.
 */
export function listFindings(report) {
  const out = [];
  for (const f of report.flags) {
    if (f.status === "missingInB") out.push({ severity: f.severity, kind: "flag", key: f.key, where: "", message: "missing in B" });
    else if (f.status === "extraInB") out.push({ severity: f.severity, kind: "flag", key: f.key, where: "", message: "only in B" });
    for (const e of f.flagLevel) out.push({ severity: e.severity, kind: "flag", key: f.key, where: "flag level", path: e.path, a: e.a, b: e.b });
    for (const [env, entries] of Object.entries(f.environments)) {
      for (const e of entries) out.push({ severity: e.severity, kind: "flag", key: f.key, where: env, path: e.path, a: e.a, b: e.b });
    }
  }
  for (const s of report.segments) {
    const where = `${s.envA}→${s.envB}`;
    if (s.status === "missingInB") out.push({ severity: s.severity, kind: "segment", key: s.key, where, message: "missing in B" });
    else if (s.status === "extraInB") out.push({ severity: s.severity, kind: "segment", key: s.key, where, message: "only in B" });
    for (const e of s.diffs) out.push({ severity: e.severity, kind: "segment", key: s.key, where, path: e.path, a: e.a, b: e.b });
  }
  return out;
}

export function summarize(report, extra = {}) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const x of listFindings(report)) counts[x.severity]++;
  const flags = { a: extra.totalA ?? 0, b: extra.totalB ?? 0, identical: 0, differing: 0, missingInB: 0, extraInB: 0, archivedA: extra.archivedA ?? 0, archivedB: extra.archivedB ?? 0 };
  for (const f of report.flags) {
    if (f.status === "identical") flags.identical++;
    else if (f.status === "differs") flags.differing++;
    else if (f.status === "missingInB") flags.missingInB++;
    else if (f.status === "extraInB") flags.extraInB++;
  }
  const segments = {};
  for (const s of report.segments) {
    const key = `${s.envA}→${s.envB}`;
    const bucket = segments[key] ??= { a: 0, b: 0, identical: 0, differing: 0, missingInB: 0, extraInB: 0 };
    if (s.status !== "extraInB") bucket.a++;
    if (s.status !== "missingInB") bucket.b++;
    if (s.status === "identical") bucket.identical++;
    else if (s.status === "differs") bucket.differing++;
    else if (s.status === "missingInB") bucket.missingInB++;
    else if (s.status === "extraInB") bucket.extraInB++;
  }
  let status = "pass";
  if (counts.error > 0 || report.errors.length > 0) status = "fail";
  else if (counts.warning > 0) status = "warn";
  return { status, flags, segments, counts };
}

const fmt = (v) => {
  if (v === undefined) return "—";
  const s = JSON.stringify(v);
  return "`" + (s.length > 120 ? s.slice(0, 117) + "..." : s).replaceAll("|", "\\|") + "`";
};

const utc = (iso) => (iso ? `${iso.slice(0, 16).replace("T", " ")}Z` : null);

/** "created 2026-10-16 09:12Z, updated …" for a side-A flag; empty when unknown. */
export function sourceTimesText(x) {
  const parts = [];
  if (x.createdA) parts.push(`created ${utc(x.createdA)}`);
  if (x.updatedA) parts.push(`updated ${utc(x.updatedA)}`);
  return parts.join(", ");
}

/** "Target last updated …" sentence; empty when B has no timestamp. */
const targetTimesText = (x) => (x.updatedB ? `Target last updated ${utc(x.updatedB)}.` : "");

const stateText = (x) => (x.archived ? " (archived)" : x.deprecated ? " (deprecated)" : "");

export function toMarkdown(report) {
  const { sides, summary, envMap } = report;
  const L = [];
  const icon = { pass: "✅", warn: "⚠️", fail: "❌" }[summary.status];
  L.push(`# LaunchDarkly project sync check: ${icon} ${summary.status.toUpperCase()}`);
  L.push("");
  L.push(`Generated ${report.generatedAt} by ${report.tool.name} v${report.tool.version}.`);
  L.push("");
  L.push("| Side | Instance | Project | Environments |");
  L.push("|---|---|---|---|");
  L.push(`| A (${sides.a.label}) | ${sides.a.baseUrl} | \`${sides.a.projectKey}\` | ${sides.a.envs.join(", ")} |`);
  L.push(`| B (${sides.b.label}) | ${sides.b.baseUrl} | \`${sides.b.projectKey}\` | ${sides.b.envs.join(", ")} |`);
  L.push("");
  L.push(`Environment mapping: ${envMap.map((m) => `${m.a} → ${m.b}`).join(", ")}. Options: ${Object.entries(report.options).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(", ") || "defaults"}.`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| | A | B | Identical | Differing | Missing in B | Extra in B |");
  L.push("|---|---|---|---|---|---|---|");
  const f = summary.flags;
  L.push(`| Flags | ${f.a} | ${f.b} | ${f.identical} | ${f.differing} | ${f.missingInB} | ${f.extraInB} |`);
  for (const [env, s] of Object.entries(summary.segments)) {
    L.push(`| Segments ${env} | ${s.a} | ${s.b} | ${s.identical} | ${s.differing} | ${s.missingInB} | ${s.extraInB} |`);
  }
  L.push("");
  L.push(`Findings by severity: ${summary.counts.error} error, ${summary.counts.warning} warning, ${summary.counts.info} info.`);
  if (report.options.includeArchived) L.push(`Archived flags: ${f.archivedA} in A, ${f.archivedB} in B (included in the counts above).`);
  L.push("");
  if (report.sync) L.push(...syncSection(report));
  const missing = report.flags.filter((x) => x.status === "missingInB");
  const extra = report.flags.filter((x) => x.status === "extraInB");
  if (missing.length) {
    L.push("## Flags missing in B");
    L.push("");
    for (const x of missing) L.push(`- \`${x.key}\`${stateText(x)}${sourceTimesText(x) ? ` — ${sourceTimesText(x)}` : ""}`);
    L.push("");
  }
  if (extra.length) {
    L.push("## Flags only in B");
    L.push("");
    for (const x of extra) L.push(`- \`${x.key}\`${stateText(x)}${x.updatedB ? ` — updated ${utc(x.updatedB)}` : ""}`);
    L.push("");
  }
  const differing = report.flags.filter((x) => x.status === "differs");
  if (differing.length) {
    L.push("## Differing flags");
    L.push("");
    for (const x of differing) {
      L.push(`### \`${x.key}\` (${x.severity})${stateText(x)}`);
      L.push("");
      if (sourceTimesText(x)) { L.push(`Source flag ${sourceTimesText(x)}.`); L.push(""); }
      if (targetTimesText(x)) { L.push(targetTimesText(x)); L.push(""); }
      if (x.flagLevel.length) {
        L.push("Flag level:");
        L.push("");
        L.push(diffTable(x.flagLevel));
        L.push("");
      }
      for (const [env, entries] of Object.entries(x.environments)) {
        if (!entries.length) continue;
        L.push(`<details><summary>Environment ${env} (${entries.length})</summary>`);
        L.push("");
        L.push(diffTable(entries));
        L.push("");
        L.push("</details>");
        L.push("");
      }
      for (const n of x.notes) L.push(`- Note: ${n}`);
      if (x.notes.length) L.push("");
    }
  }
  const infoOnly = report.flags.filter((x) => x.status === "identical" && x.severity === "info");
  if (infoOnly.length) {
    L.push("## Identical flags with informational differences");
    L.push("");
    L.push("These differ between instances by design (maintainers, experiments, views, or rules that reference segments deleted from A and so can never match) and do not affect evaluation.");
    L.push("");
    for (const x of infoOnly) {
      const entries = [...x.flagLevel, ...Object.values(x.environments).flat()];
      L.push(`- \`${x.key}\`: ${entries.map((e) => e.path).join(", ")}${x.notes.length ? ` — ${x.notes.join(" ")}` : ""}`);
    }
    L.push("");
  }
  const segIssues = report.segments.filter((s) => s.status !== "identical");
  if (segIssues.length) {
    L.push("## Segments");
    L.push("");
    for (const s of segIssues) {
      L.push(`### \`${s.key}\` ${s.envA} → ${s.envB}: ${s.status} (${s.severity})`);
      L.push("");
      if (sourceTimesText(s)) { L.push(`Source segment ${sourceTimesText(s)}.`); L.push(""); }
      if (targetTimesText(s)) { L.push(targetTimesText(s)); L.push(""); }
      if (s.diffs.length) { L.push(diffTable(s.diffs)); L.push(""); }
      for (const n of s.notes) L.push(`- Note: ${n}`);
      if (s.notes.length) L.push("");
    }
  }
  if (report.evaluation?.length) {
    L.push("## Sample context evaluation");
    L.push("");
    for (const ev of report.evaluation) {
      L.push(`- ${ev.envA} → ${ev.envB}, context ${fmt(ev.context)}: ${ev.flagsCompared} flags compared, ${ev.differing.length} differing${ev.onlyInA.length || ev.onlyInB.length ? `, only in A: ${ev.onlyInA.length}, only in B: ${ev.onlyInB.length}` : ""}.`);
      for (const d of ev.differing) L.push(`  - \`${d.key}\`: A ${fmt(d.a)} vs B ${fmt(d.b)}`);
    }
    L.push("");
  }
  if (report.errors.length) {
    L.push("## Fetch errors");
    L.push("");
    for (const e of report.errors) L.push(`- ${e.context ?? ""} HTTP ${e.status}: ${e.message}`);
    L.push("");
  }
  return L.join("\n");
}

const STATE_TITLES = {
  conflict: "Changed on both sides (the source change is not applied)",
  editedInTarget: "Changed in B after the last sync (left as it is by the migration)",
  pendingSource: "Waiting for the next sync",
  cutOver: "Environment cut over (no longer synced)",
  untracked: "Not tracked by the migration",
};

/** "Sync state" section: last sync and run, and the flags and segments per state. */
export function syncSection(report) {
  const { manifest, run, cutOver, warnings } = report.sync;
  const L = ["## Sync state", ""];
  L.push(`Last sync ${utc(manifest.lastSyncTimestamp) ?? "unknown"} (\`${manifest.sourceProject}\` → \`${manifest.destProject}\`), ${manifest.flagsTracked} flags and ${manifest.segmentsTracked} segments tracked.`);
  if (run) {
    const c = run.counts ?? {};
    L.push(`Last run ${utc(run.startedAt)}: ${run.mode ?? "?"}${run.dryRun ? " (dry run)" : ""}, tooling ${run.toolVersion ?? "?"}, exit code ${run.exitCode ?? "?"}; ${c.flagsSkippedUnchanged ?? 0} flags unchanged, ${run.protected} destination edits left as they are (${run.conflicts} conflicts).`);
  }
  if (cutOver.length) L.push(`Cut over (no longer synced): ${cutOver.map((p) => `${p.a} → ${p.b}`).join(", ")}.`);
  for (const w of warnings) L.push(`- ⚠️ ${w}`);
  L.push("");
  for (const [state, title] of Object.entries(STATE_TITLES)) {
    const flags = report.flags.filter((x) => x.sync?.state === state && x.status !== "identical");
    const segments = report.segments.filter((x) => x.sync?.state === state && x.status !== "identical");
    if (!flags.length && !segments.length) continue;
    L.push(`**${title}**: ${[...flags.map((x) => `\`${x.key}\``), ...segments.map((x) => `segment \`${x.key}\` (${x.envA})`)].join(", ")}`);
    L.push("");
  }
  return L;
}

function diffTable(entries) {
  const rows = ["| Path | A | B | Severity |", "|---|---|---|---|"];
  for (const e of entries) rows.push(`| \`${e.path}\` | ${fmt(e.a)} | ${fmt(e.b)} | ${e.severity} |`);
  return rows.join("\n");
}

// --- plain-language views (the page's drift check, and a report shared with the customer) ---

/**
 * Groups of a report's differences by what they mean, in reading order. `title` and `hint` take the
 * side labels (e.g. "EU"). The sync groups only fill when the report carries sync states.
 */
export const MEANING_GROUPS = [
  { id: "unexpected", title: () => "Different and unexpected", hint: () => "Nothing explains these differences. Check them." },
  { id: "conflict", title: () => "Changed on both sides", hint: (a, b) => `Changed in ${b} after the migration and in ${a} since; the migration keeps ${b}'s version.` },
  { id: "protected", title: (_a, b) => `Changed in ${b} after the migration (protected)`, hint: () => "The migration leaves these as they are." },
  { id: "pending", title: () => "Waiting for the next sync", hint: (a) => `Changed in ${a} since the last sync; the next sync copies the change.` },
  { id: "cutOver", title: () => "No longer synced", hint: () => "The environment was cut over, so its differences are expected." },
  { id: "onlyInB", title: (_a, b) => `Only in ${b}`, hint: (a, b) => `Created in ${b}, or no longer in ${a}.` },
  { id: "minor", title: () => "Minor differences", hint: () => "Fields that differ between instances by design. Informational only." },
];

const GROUP_FOR = { conflict: "conflict", editedInTarget: "protected", pendingSource: "pending", cutOver: "cutOver" };
// Own keys only: a state from a shared file can be any string ("constructor", say)
const groupForState = (state) => (typeof state === "string" && Object.hasOwn(GROUP_FOR, state) ? GROUP_FOR[state] : undefined);

const worstOf = (entries) => {
  let w = "info";
  for (const e of entries) {
    if (e.severity === "error") return "error";
    if (e.severity === "warning") w = "warning";
  }
  return w;
};

/**
 * The report's differences grouped by meaning: [{ id, items: [{ kind, key, keyB?, where[] }] }], only
 * non-empty groups, in MEANING_GROUPS order. A flag can sit in several groups (one per part).
 */
export function meaningGroups(report) {
  const groups = new Map(MEANING_GROUPS.map((g) => [g.id, new Map()]));
  const add = (group, kind, key, keyB, where) => {
    const items = groups.get(group);
    const id = `${kind} ${key} ${kind === "segment" ? where : ""}`;
    const item = items.get(id) ?? { kind, key, ...(keyB && keyB !== key ? { keyB } : {}), where: [] };
    if (where && !item.where.includes(where)) item.where.push(where);
    items.set(id, item);
  };
  // A difference without an explaining sync state is unexpected, unless it is informational only
  const place = (state, entries) => groupForState(state) ?? (worstOf(entries) === "info" ? "minor" : "unexpected");
  for (const f of report.flags) {
    if (f.status === "extraInB") { add("onlyInB", "flag", f.key, f.keyB, ""); continue; }
    if (f.status === "missingInB") { add(groupForState(f.sync?.state) ?? "unexpected", "flag", f.key, f.keyB, "missing in B"); continue; }
    if (f.flagLevel.length) add(place(f.sync?.flagLevel, f.flagLevel), "flag", f.key, f.keyB, "flag level");
    for (const [env, entries] of Object.entries(f.environments)) {
      if (entries.length) add(place(f.sync?.environments?.[env], entries), "flag", f.key, f.keyB, env);
    }
  }
  for (const s of report.segments) {
    const where = `${s.envA}→${s.envB}`;
    if (s.status === "extraInB") add("onlyInB", "segment", s.key, s.keyB, where);
    else if (s.status === "missingInB") add(groupForState(s.sync?.state) ?? "unexpected", "segment", s.key, s.keyB, where);
    else if (s.diffs.length) add(place(s.sync?.state, s.diffs), "segment", s.key, s.keyB, where);
  }
  return MEANING_GROUPS.filter((g) => groups.get(g.id).size).map((g) => ({ id: g.id, items: [...groups.get(g.id).values()] }));
}

/** One sentence for the verdict, from the summary and the meaning groups. */
export function verdictText(report, groups = meaningGroups(report)) {
  const items = (k) => `${k} item${k === 1 ? "" : "s"}`;
  // Counted from the findings, as the status is, not from each result's own severity
  const withSeverity = (sev) => new Set(listFindings(report).filter((x) => x.severity === sev)
    .map((x) => `${x.kind} ${x.key} ${x.kind === "segment" ? x.where : ""}`)).size;
  if (report.errors.length) return "Incomplete: some requests failed, so not everything was compared.";
  const { status } = report.summary;
  if (status === "fail") return `Out of sync: ${items(withSeverity("error"))} with unexpected differences.`;
  if (status === "warn") return `Nearly in sync: ${items(withSeverity("warning"))} to look at.`;
  const explained = groups.reduce((k, g) => k + g.items.length, 0);
  return explained ? `In sync, apart from expected differences (${items(explained)}).` : "In sync: every compared flag and segment matches.";
}

/** "Last sync 2026-10-22 08:56Z · 326 flags tracked · 3.6.1 · dry-run 2026-10-28 12:37Z · 15 protected (2 conflicts)". */
export function syncStatusLine(sync) {
  if (!sync) return "";
  const { manifest, run } = sync;
  const parts = [`Last sync ${utc(manifest.lastSyncTimestamp) ?? "unknown"}`, `${manifest.flagsTracked} flags tracked`];
  if (run) {
    if (run.toolVersion) parts.push(run.toolVersion);
    const mode = run.mode ?? "run";
    parts.push(`${run.dryRun && !mode.includes("dry") ? `${mode} (dry run)` : mode} ${utc(run.startedAt)}`);
    // The conflicts are among the protected edits (the source changed too)
    parts.push(`${run.protected} protected${run.conflicts ? ` (${run.conflicts} conflict${run.conflicts === 1 ? "" : "s"})` : ""}`);
  }
  return parts.join(" · ");
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const FLAG_STATUSES = ["identical", "differs", "missingInB", "extraInB"];
const SEVERITY_VALUES = ["error", "warning", "info", "none"];
const isEntries = (v) => Array.isArray(v) && v.every((e) => isObject(e) && isStr(e.path) && SEVERITY_VALUES.includes(e.severity));
const isCounts = (v) => isObject(v) && Object.values(v).every(Number.isInteger);
const isRunItems = (v) => Array.isArray(v) && v.every((r) => isObject(r) && isStr(r.key));
/** The sync block annotateWithManifest writes, as far as the page reads it. */
const isSync = (sync) => {
  if (!isObject(sync) || !isObject(sync.manifest) || !Array.isArray(sync.warnings) || !sync.warnings.every(isStr)) return false;
  const m = sync.manifest;
  if (!Number.isInteger(m.flagsTracked) || !Number.isInteger(m.segmentsTracked) || ![m.lastSyncTimestamp, m.sourceProject, m.destProject].every((v) => v === null || isStr(v))) return false;
  if (!isObject(sync.counts) || !isCounts(sync.counts.flags) || !isCounts(sync.counts.segments)) return false;
  if (!Array.isArray(sync.cutOver) || !sync.cutOver.every((p) => isObject(p) && isStr(p.a) && isStr(p.b))) return false;
  const run = sync.run;
  if (run === null || run === undefined) return true;
  const optionalStr = (v) => v === undefined || v === null || isStr(v);
  return isObject(run) && isStr(run.startedAt) && Number.isInteger(run.protected) && Number.isInteger(run.conflicts) &&
    optionalStr(run.mode) && optionalStr(run.toolVersion) &&
    (run.items === undefined || (isObject(run.items) && isRunItems(run.items.protected) && isRunItems(run.items.conflicts)));
};
const isHttps = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Validates a report someone shared (the JSON this tool writes) before the page shows it. Throws on
 * anything else. The status and counts are recomputed from the findings, not taken from the file.
 */
export function parseReport(json) {
  const fail = (what) => { throw new Error(`not a sync check report (${what})`); };
  if (!isObject(json) || !isObject(json.sides) || !Array.isArray(json.flags) || !Array.isArray(json.segments)) fail("expected sides, flags and segments");
  for (const id of ["a", "b"]) {
    const side = json.sides[id];
    if (!isObject(side) || !isStr(side.projectKey) || !isStr(side.label) || !isHttps(side.baseUrl) || !Array.isArray(side.envs)) fail(`sides.${id}`);
  }
  if (!isStr(json.generatedAt) || Number.isNaN(Date.parse(json.generatedAt))) fail("generatedAt");
  if (!Array.isArray(json.envMap) || !json.envMap.every((m) => isObject(m) && isStr(m.a) && isStr(m.b))) fail("envMap");
  if (!isObject(json.options) || !isObject(json.summary) || !isObject(json.summary.flags)) fail("options and summary");
  if (json.errors !== undefined && !(Array.isArray(json.errors) && json.errors.every((e) => isObject(e) && isStr(e.message) && Number.isFinite(e.status) && (e.context === undefined || e.context === null || isStr(e.context))))) fail("errors");
  json.flags.forEach((f, i) => {
    if (!isObject(f) || !isStr(f.key) || !FLAG_STATUSES.includes(f.status) || !SEVERITY_VALUES.includes(f.severity)) fail(`flags[${i}]`);
    if (!isEntries(f.flagLevel) || !isObject(f.environments) || !Object.values(f.environments).every(isEntries) || !Array.isArray(f.notes)) fail(`flags[${i}]`);
  });
  json.segments.forEach((s, i) => {
    if (!isObject(s) || !isStr(s.key) || !isStr(s.envA) || !isStr(s.envB) || !FLAG_STATUSES.includes(s.status) || !SEVERITY_VALUES.includes(s.severity) || !isEntries(s.diffs) || !Array.isArray(s.notes)) fail(`segments[${i}]`);
  });
  if (json.sync !== undefined && !isSync(json.sync)) fail("sync");
  const report = { ...json, errors: json.errors ?? [], tool: isObject(json.tool) ? json.tool : { name: "ld-project-sync-check", version: "?" } };
  report.summary = { ...summarize(report), flags: json.summary.flags };
  return report;
}
