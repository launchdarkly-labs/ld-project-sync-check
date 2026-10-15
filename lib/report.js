// Summaries and Markdown rendering for a Report produced by compare.js.

export function summarize(report, extra = {}) {
  const counts = { error: 0, warning: 0, info: 0 };
  const flags = { a: extra.totalA ?? 0, b: extra.totalB ?? 0, identical: 0, differing: 0, missingInB: 0, extraInB: 0, archivedA: extra.archivedA ?? 0, archivedB: extra.archivedB ?? 0 };
  for (const f of report.flags) {
    if (f.status === "identical") flags.identical++;
    else if (f.status === "differs") flags.differing++;
    else if (f.status === "missingInB") { flags.missingInB++; counts.error++; }
    else if (f.status === "extraInB") { flags.extraInB++; counts[f.severity]++; }
    for (const e of [...f.flagLevel, ...Object.values(f.environments).flat()]) counts[e.severity]++;
  }
  const segments = {};
  for (const s of report.segments) {
    const key = `${s.envA}→${s.envB}`;
    const bucket = segments[key] ??= { a: 0, b: 0, identical: 0, differing: 0, missingInB: 0, extraInB: 0 };
    if (s.status !== "extraInB") bucket.a++;
    if (s.status !== "missingInB") bucket.b++;
    if (s.status === "identical") bucket.identical++;
    else if (s.status === "differs") bucket.differing++;
    else if (s.status === "missingInB") { bucket.missingInB++; counts.error++; }
    else if (s.status === "extraInB") { bucket.extraInB++; counts[s.severity]++; }
    for (const e of s.diffs) counts[e.severity]++;
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
    for (const x of missing) L.push(`- \`${x.key}\`${x.archived ? " (archived)" : ""}`);
    L.push("");
  }
  if (extra.length) {
    L.push("## Flags only in B");
    L.push("");
    for (const x of extra) L.push(`- \`${x.key}\`${x.archived ? " (archived)" : ""}`);
    L.push("");
  }
  const differing = report.flags.filter((x) => x.status === "differs");
  if (differing.length) {
    L.push("## Differing flags");
    L.push("");
    for (const x of differing) {
      L.push(`### \`${x.key}\` (${x.severity})`);
      L.push("");
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
    L.push("These fields differ between instances by design (maintainers, experiments, views) and do not affect evaluation.");
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
