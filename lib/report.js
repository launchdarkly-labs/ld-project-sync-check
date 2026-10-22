// Summaries and Markdown rendering for a Report produced by compare.js.

/**
 * Every finding behind the severity counts, one entry per missing/extra item or differing field:
 * { severity, kind: "flag"|"segment", key, where, path?, a?, b?, message? }.
 */
export function listFindings(report) {
  const out = [];
  for (const f of report.flags) {
    if (f.status === "missingInB") out.push({ severity: "error", kind: "flag", key: f.key, where: "", message: "missing in B" });
    else if (f.status === "extraInB") out.push({ severity: f.severity, kind: "flag", key: f.key, where: "", message: "only in B" });
    for (const e of f.flagLevel) out.push({ severity: e.severity, kind: "flag", key: f.key, where: "flag level", path: e.path, a: e.a, b: e.b });
    for (const [env, entries] of Object.entries(f.environments)) {
      for (const e of entries) out.push({ severity: e.severity, kind: "flag", key: f.key, where: env, path: e.path, a: e.a, b: e.b });
    }
  }
  for (const s of report.segments) {
    const where = `${s.envA}→${s.envB}`;
    if (s.status === "missingInB") out.push({ severity: "error", kind: "segment", key: s.key, where, message: "missing in B" });
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
    for (const x of extra) L.push(`- \`${x.key}\`${stateText(x)}`);
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

function diffTable(entries) {
  const rows = ["| Path | A | B | Severity |", "|---|---|---|---|"];
  for (const e of entries) rows.push(`| \`${e.path}\` | ${fmt(e.a)} | ${fmt(e.b)} | ${e.severity} |`);
  return rows.join("\n");
}
