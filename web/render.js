// DOM builders. Everything from the API goes through textContent, never innerHTML.

import { SEVERITIES } from "../lib/severity.js";
import { SYNC_STATE_LABELS } from "../lib/manifest.js";
import { MEANING_GROUPS, syncStatusLine, verdictText } from "../lib/report.js";

export const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};

const show = (v) => (v === undefined ? "—" : JSON.stringify(v));

export function badge(text) {
  return el("span", { class: `badge ${text}` }, text === "missingInB" ? "missing in B" : text === "extraInB" ? "only in B" : text);
}

export const SYNC_SHORT = { pendingSource: "pending", editedInTarget: "edited in B", conflict: "conflict", cutOver: "cut over", untracked: "untracked", inSync: "no change since sync" };
/** The sync state of a result; "in sync" when it is identical, "unexplained" when it differs anyway. */
export function syncBadge(state, status) {
  if (!state) return el("span", { class: "muted" }, "—");
  if (state === "inSync") {
    return status === "identical"
      ? el("span", { class: "badge sync-ok", title: "Identical, and neither side changed since the last sync" }, "in sync")
      : el("span", { class: "badge sync-inSync", title: SYNC_STATE_LABELS.inSync }, "unexplained");
  }
  return el("span", { class: `badge sync-${state}`, title: SYNC_STATE_LABELS[state] }, SYNC_SHORT[state] ?? state);
}

// --- time helpers ---
const DAY = 86400000;
export function relTime(iso, now = Date.now()) {
  if (!iso) return "";
  const d = now - Date.parse(iso);
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
  if (d < DAY) return `${Math.floor(d / 3600000)} h ago`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : undefined);
const isRecent = (iso) => Boolean(iso) && Date.now() - Date.parse(iso) < 7 * DAY;

// --- lifecycle state ---
export const STATES = [
  { id: "active", label: "Active", test: (f) => !f.archived },
  { id: "deprecated", label: "Deprecated", test: (f) => f.deprecated && !f.archived },
  { id: "archived", label: "Archived", test: (f) => f.archived },
  { id: "all", label: "All", test: () => true },
];
export const inState = (state) => STATES.find((s) => s.id === state)?.test ?? (() => true);

export function renderStateTabs(container, flags, current, archivedFetched, onSelect) {
  container.textContent = "";
  for (const s of STATES) {
    const n = flags.filter(s.test).length;
    const count = s.id === "archived" && !archivedFetched ? "—" : n;
    container.append(el("button", {
      type: "button", role: "tab", "aria-selected": String(s.id === current), "data-state": s.id,
      onclick: () => onSelect(s.id),
    }, s.label, el("span", { class: "c" }, count)));
  }
}

const SEV_LABEL = { error: "errors", warning: "warnings", info: "info" };

/** Counts with findings are buttons; onCount(severity) opens that list in the findings panel. */
export function renderStatus(container, report, onCount = () => {}) {
  const s = report.summary;
  container.textContent = "";
  container.className = `status ${s.status}`;
  const count = (sev) => {
    const text = `${s.counts[sev]} ${SEV_LABEL[sev]}`;
    if (!s.counts[sev]) return text;
    return el("button", { type: "button", class: `count-link${sev === "error" ? " strong" : ""}`, title: `Show ${SEV_LABEL[sev]}`, onclick: () => onCount(sev) }, text);
  };
  container.append(
    el("span", { class: "verdict" }, s.status.toUpperCase()),
    el("span", { class: "meta" },
      count("error"), " · ", count("warning"), " · ", count("info"),
      el("br"),
      `${report.sides.a.projectKey} (${report.sides.a.label}) → ${report.sides.b.projectKey} (${report.sides.b.label}) · ${new Date(report.generatedAt).toLocaleString()}`),
  );
}

/**
 * Summary: source/target pair, flag results (proportion bar + one tile per result, click to
 * filter the table), and one tile per segment environment pair.
 */
export function renderSummary(container, report, onPick = () => {}) {
  const f = report.summary.flags;
  const archived = report.options.includeArchived;
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "—");
  container.textContent = "";
  const group = (label, ...kids) => el("section", { class: "sum-group" }, el("h3", { class: "sum-label" }, label), ...kids);

  const side = (id, s, total, arch) => el("div", { class: "tile side-tile" },
    el("div", { class: "tile-top" }, el("span", { class: "side-chip" }, id.toUpperCase()), el("span", { class: "tile-title" }, id === "a" ? "Source" : "Target"), el("span", { class: "tile-tag" }, s.label)),
    el("div", { class: "tile-n" }, total, el("span", { class: "unit" }, " flags")),
    el("div", { class: "tile-sub" }, el("code", {}, s.projectKey), archived ? ` · ${total - arch} active · ${arch} archived` : " · active only"),
  );

  const results = [
    { id: "identical", label: "Identical", n: f.identical, sub: `${pct(f.identical, f.a)} of A`, tone: "ok" },
    { id: "differs", label: "Differing", n: f.differing, sub: "fields differ", tone: "warn" },
    { id: "missingInB", label: "Missing in B", n: f.missingInB, sub: "not in target", tone: "err" },
    { id: "extraInB", label: "Only in B", n: f.extraInB, sub: "extra in target", tone: "info" },
  ];
  const total = results.reduce((a, r) => a + r.n, 0);
  const bar = el("div", { class: "bar", role: "img", "aria-label": results.map((r) => `${r.label} ${r.n}`).join(", ") },
    results.filter((r) => r.n).map((r) => {
      const seg = el("span", { class: `seg ${r.tone}`, title: `${r.label}: ${r.n}` });
      seg.style.flexGrow = String(r.n); // CSSOM, not a style attribute: CSP has no 'unsafe-inline'
      return seg;
    }));
  const tiles = el("div", { class: "result-tiles" }, results.map((r) => el("button", {
    type: "button", class: `tile result ${r.n ? r.tone : "zero"}`, title: `Show ${r.label.toLowerCase()} flags`,
    onclick: () => onPick(r.id),
  }, el("div", { class: "tile-top" }, el("span", { class: "swatch" }), el("span", { class: "tile-title" }, r.label)),
    el("div", { class: "tile-n" }, r.n), el("div", { class: "tile-sub" }, r.sub))));

  container.append(
    group("Projects", el("div", { class: "side-tiles" }, side("a", report.sides.a, f.a, f.archivedA), side("b", report.sides.b, f.b, f.archivedB))),
    group(`Flag results · ${total} compared`, el("div", { class: "results-card" }, bar, tiles)),
  );

  const segs = Object.entries(report.summary.segments);
  if (segs.length) {
    container.append(group("Segments", el("div", { class: "seg-tiles" }, segs.map(([env, g]) => {
      const clean = g.identical === g.a && g.extraInB === 0;
      const issues = [g.differing && `${g.differing} differing`, g.missingInB && `${g.missingInB} missing`, g.extraInB && `${g.extraInB} only in B`].filter(Boolean);
      return el("div", { class: `tile seg-tile ${clean ? "ok" : "err"}` },
        el("div", { class: "tile-top" }, el("span", { class: "swatch" }), el("span", { class: "tile-title" }, env)),
        el("div", { class: "tile-n" }, g.identical, el("span", { class: "unit" }, ` / ${g.a} identical`)),
        el("div", { class: "tile-sub" }, issues.length ? issues.join(" · ") : "all in sync"));
    }))));
  }
}

/**
 * Every finding behind the status counts, one collapsible list per severity. Each list is a
 * <details data-sev="…">; renderStatus' count buttons open them.
 */
export function renderFindings(container, findings) {
  container.textContent = "";
  for (const sev of SEVERITIES) {
    const items = findings.filter((x) => x.severity === sev);
    if (!items.length) continue;
    const t = el("table", { class: "diff" }, el("thead", {}, el("tr", {}, el("th", {}, "Item"), el("th", {}, "Where"), el("th", {}, "Path"), el("th", {}, "A"), el("th", {}, "B"))));
    const body = el("tbody");
    for (const x of items) {
      const diff = x.path !== undefined
        ? [el("td", {}, el("code", {}, x.path)), el("td", {}, el("code", {}, show(x.a))), el("td", {}, el("code", {}, show(x.b)))]
        : [el("td", { colspan: 3 }, badge(x.message === "missing in B" ? "missingInB" : "extraInB"))];
      body.append(el("tr", {},
        el("td", { class: "key" }, x.key, el("span", { class: "chip" }, x.kind)),
        el("td", {}, x.where || "—"),
        diff));
    }
    t.append(body);
    container.append(el("details", { class: `findings ${sev}`, "data-sev": sev },
      el("summary", {}, badge(sev), ` ${items.length} ${SEV_LABEL[sev]}`), el("div", { class: "findings-body" }, t)));
  }
}

/** Quick key lists for the flags currently in view (same state filter as the table). */
export function renderLists(container, flags) {
  container.textContent = "";
  const missing = flags.filter((x) => x.status === "missingInB");
  const extra = flags.filter((x) => x.status === "extraInB");
  const item = (x, withTime) => el("span", { class: "item", title: withTime && x.createdA ? `Created ${fullTime(x.createdA)}` : undefined }, x.key, withTime && x.createdA ? el("span", { class: "when" }, `created ${relTime(x.createdA)}`) : null);
  if (missing.length) container.append(el("div", { class: "list" }, el("strong", {}, `Missing in B (${missing.length})`), missing.map((x) => item(x, true))));
  if (extra.length) container.append(el("div", { class: "list" }, el("strong", {}, `Only in B (${extra.length})`), extra.map((x) => item(x, false))));
}

function diffTable(entries) {
  const t = el("table", { class: "diff" }, el("thead", {}, el("tr", {}, el("th", {}, "Path"), el("th", {}, "A"), el("th", {}, "B"), el("th", {}, "Severity"))));
  const body = el("tbody");
  for (const e of entries) body.append(el("tr", {}, el("td", {}, el("code", {}, e.path)), el("td", {}, el("code", {}, show(e.a))), el("td", {}, el("code", {}, show(e.b))), el("td", {}, badge(e.severity))));
  t.append(body);
  return t;
}

const flagUrl = (side, key) => `${side.baseUrl}/projects/${encodeURIComponent(side.projectKey)}/flags/${encodeURIComponent(key)}`;
const extLink = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

function flagDetail(f, sides) {
  const d = el("div", { class: "detail" });
  const meta = el("div", { class: "detail-meta" });
  if (f.createdA) meta.append(el("span", {}, `Created in A ${fullTime(f.createdA)}`));
  if (f.updatedA) meta.append(el("span", { title: "Latest targeting change among the compared A environments" }, `Last changed ${fullTime(f.updatedA)} (compared envs)`));
  if (f.updatedB) meta.append(el("span", { title: "Latest targeting change among the compared B environments" }, `Last changed in B ${fullTime(f.updatedB)}`));
  if (f.status !== "extraInB") meta.append(extLink(flagUrl(sides.a, f.key), "Open in A ↗"));
  if (f.status !== "missingInB") meta.append(extLink(flagUrl(sides.b, f.keyB), "Open in B ↗"));
  d.append(meta);
  if (f.flagLevel.length) d.append(el("h4", {}, "Flag level"), diffTable(f.flagLevel));
  for (const [env, entries] of Object.entries(f.environments)) if (entries.length) d.append(el("h4", {}, `Environment ${env}`), diffTable(entries));
  if (!f.flagLevel.length && !Object.values(f.environments).some((e) => e.length)) d.append(el("p", { class: "notes" }, f.status === "identical" ? "No differences." : "No field-level details."));
  if (f.notes.length) d.append(el("ul", { class: "notes" }, f.notes.map((n) => el("li", {}, n))));
  return d;
}

/** A clickable / keyboard-toggleable row with a hidden detail row under it. */
function expandable(cells, colspan, detailContent) {
  const detail = el("tr", { class: "detail", hidden: true }, el("td", { colspan }, detailContent));
  const toggle = () => { detail.hidden = !detail.hidden; row.setAttribute("aria-expanded", String(!detail.hidden)); };
  const row = el("tr", {
    class: "row", tabindex: "0", "aria-expanded": "false",
    onclick: (e) => { if (!e.target.closest("a")) toggle(); },
    onkeydown: (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } },
  }, cells);
  return [row, detail];
}

function stateChips(f) {
  const chips = [];
  if (f.droppedRules) chips.push(el("span", { class: "chip", title: "Rule(s) referencing deleted segments; they can't exist in B and never match in A" }, `${f.droppedRules} dead rule${f.droppedRules > 1 ? "s" : ""} skipped`));
  if (f.archived) chips.push(el("span", { class: "chip" }, "archived"));
  else if (f.deprecated) chips.push(el("span", { class: "chip" }, "deprecated"));
  if (f.status !== "extraInB" && f.status !== "missingInB" && f.archivedB !== undefined && f.archivedB !== f.archived) {
    chips.push(el("span", { class: "chip warn" }, f.archivedB ? "archived in B" : "active in B"));
  }
  return chips;
}

// Ascending comparators; "desc" reverses. Missing timestamps sort as oldest.
const ts = (iso) => (iso ? Date.parse(iso) : 0);
export const SORTS = {
  key: { cmp: (x, y) => x.key.localeCompare(y.key), firstDir: "asc" },
  created: { cmp: (x, y) => ts(x.createdA) - ts(y.createdA), firstDir: "desc" },
  updated: { cmp: (x, y) => ts(x.updatedA) - ts(y.updatedA), firstDir: "desc" },
  updatedB: { cmp: (x, y) => ts(x.updatedB) - ts(y.updatedB), firstDir: "desc" },
};

/**
 * @param {object} o { flags, sides, sort: {key, dir}|null, onSort(key), state, archivedFetched, countEl }
 */
export function renderFlags(container, o) {
  container.textContent = "";
  const { flags, sides, sort, state, countEl } = o;
  countEl.textContent = `${flags.length} flag(s)`;
  if (state === "archived" && !o.archivedFetched) {
    container.append(el("p", { class: "empty" }, "Archived flags were not fetched. Enable “Include archived flags” and run the check again."));
    return;
  }
  if (!flags.length) { container.append(el("p", { class: "empty" }, "No flags match the current filters.")); return; }

  let rows = [...flags];
  if (sort && SORTS[sort.key]) {
    rows.sort(SORTS[sort.key].cmp);
    if (sort.dir === "desc") rows.reverse();
  }
  // In "All", archived flags form their own group after the active ones.
  const grouped = state === "all" && rows.some((f) => f.archived) && rows.some((f) => !f.archived);
  if (grouped) rows = [...rows.filter((f) => !f.archived), ...rows.filter((f) => f.archived)];

  const th = (label, key, title) => {
    if (!key) return el("th", { title }, label);
    const active = sort?.key === key;
    const arrow = active ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
    return el("th", { title, "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
      el("button", { type: "button", class: `sort${active ? " on" : ""}`, "data-sort": key, onclick: () => o.onSort(key) }, label, arrow));
  };
  const withSync = Boolean(o.withSync);
  const COLS = withSync ? 8 : 7;
  const t = el("table", {}, el("thead", {}, el("tr", {},
    th("Flag key", "key"),
    th("Result"),
    withSync ? th("Sync", undefined, "Why the flag differs, from the migration's manifest") : null,
    th("Severity"),
    th("Created (A)", "created", "When the flag was created in the source project"),
    th("Updated (A)", "updated", "Latest targeting change among the compared source environments"),
    th("Updated (B)", "updatedB", "Latest targeting change among the compared target environments. A change here after the migration means the flag was edited in B"),
    th("Findings"),
  )));
  const body = el("tbody");
  let groupDone = false;
  for (const f of rows) {
    if (grouped && f.archived && !groupDone) {
      body.append(el("tr", { class: "group" }, el("td", { colspan: COLS }, `Archived flags (${rows.filter((x) => x.archived).length})`)));
      groupDone = true;
    }
    const n = f.flagLevel.length + Object.values(f.environments).reduce((a, e) => a + e.length, 0);
    const timeCell = (iso) => el("td", { class: `time${isRecent(iso) ? " recent" : ""}`, title: fullTime(iso) }, iso ? relTime(iso) : "—");
    body.append(...expandable([
      el("td", { class: "key" }, f.key, stateChips(f)),
      el("td", {}, badge(f.status)),
      withSync ? el("td", {}, syncBadge(f.sync?.state, f.status)) : null,
      el("td", {}, badge(f.severity)),
      f.status === "extraInB" ? el("td", { class: "time muted" }, "—") : timeCell(f.createdA),
      f.status === "extraInB" ? el("td", { class: "time muted" }, "—") : timeCell(f.updatedA),
      f.status === "missingInB" ? el("td", { class: "time muted" }, "—") : timeCell(f.updatedB),
      el("td", {}, n ? `${n} field(s)` : "", f.notes.length ? `${n ? " · " : ""}${f.notes.length} note(s)` : ""),
    ], COLS, flagDetail(f, sides)));
  }
  t.append(body);
  container.append(t);
}

export function renderSegments(container, segments, withSync = false) {
  container.textContent = "";
  if (!segments.length) { container.append(el("p", { class: "empty" }, "No segments in the compared environments.")); return; }
  const t = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "Segment"),
    el("th", {}, "Environments"),
    el("th", {}, "Result"),
    withSync ? el("th", { title: "Why the segment differs, from the migration's manifest" }, "Sync") : null,
    el("th", {}, "Severity"),
    el("th", { title: "When the segment was created in the source environment" }, "Created (A)"),
    el("th", { title: "Last change to the segment in the source environment" }, "Updated (A)"),
    el("th", { title: "Last change to the segment in the target environment. A change here after the migration means the segment was edited in B" }, "Updated (B)"),
  )));
  const body = el("tbody");
  const timeCell = (iso) => el("td", { class: `time${isRecent(iso) ? " recent" : ""}`, title: fullTime(iso) }, iso ? relTime(iso) : "—");
  for (const s of segments) {
    const detail = el("div", { class: "detail" }, s.diffs.length ? diffTable(s.diffs) : el("p", { class: "notes" }, "No differences."), s.notes.length ? el("ul", { class: "notes" }, s.notes.map((n) => el("li", {}, n))) : null);
    body.append(...expandable([
      el("td", { class: "key" }, s.key),
      el("td", {}, `${s.envA} → ${s.envB}`),
      el("td", {}, badge(s.status)),
      withSync ? el("td", {}, syncBadge(s.sync?.state, s.status)) : null,
      el("td", {}, badge(s.severity)),
      s.status === "extraInB" ? el("td", { class: "time muted" }, "—") : timeCell(s.createdA),
      s.status === "extraInB" ? el("td", { class: "time muted" }, "—") : timeCell(s.updatedA),
      s.status === "missingInB" ? el("td", { class: "time muted" }, "—") : timeCell(s.updatedB),
    ], withSync ? 8 : 7, detail));
  }
  t.append(body);
  container.append(t);
}

export function renderErrors(container, errors) {
  container.textContent = "";
  if (!errors.length) return;
  container.append(el("div", { class: "errbox" }, el("strong", {}, "Some requests failed; the report is incomplete."), el("ul", {}, errors.map((e) => el("li", {}, `${e.context ?? ""} HTTP ${e.status}: ${e.message}`)))));
}

// --- plain-language result (both views) and migration state (operator view) ---

export function renderVerdict(container, report, groups) {
  container.textContent = verdictText(report, groups);
  container.className = `verdict-text ${report.summary.status}`;
}

/** One block per meaning group, each listing its flags and segments with where they differ. */
export function renderMeaning(container, report, groups) {
  container.textContent = "";
  const a = report.sides.a.label, b = report.sides.b.label;
  for (const g of groups) {
    const def = MEANING_GROUPS.find((x) => x.id === g.id);
    const list = el("ul", { class: "meaning-items" }, g.items.map((x) => el("li", {},
      el("span", { class: "key" }, x.key), x.keyB ? el("span", { class: "muted" }, ` (${x.keyB} in B)`) : null,
      x.kind === "segment" ? el("span", { class: "chip" }, "segment") : null,
      x.where.length ? el("span", { class: "where" }, x.where.join(", ")) : null)));
    container.append(el("details", { class: `meaning-group ${g.id}`, open: g.id === "unexpected" || g.id === "conflict" },
      el("summary", {}, el("span", { class: "swatch" }), el("strong", {}, def.title(a, b)), el("span", { class: "c" }, g.items.length)),
      el("p", { class: "hint" }, def.hint(a, b)),
      list));
  }
}

export function renderSyncLine(line, warningsList, sync) {
  line.textContent = syncStatusLine(sync);
  line.hidden = !sync;
  warningsList.textContent = "";
  const warnings = sync?.warnings ?? [];
  for (const w of warnings) warningsList.append(el("li", {}, w));
  warningsList.hidden = !warnings.length;
}

/** What the last run (as its run record tells) left as it is in B. */
export function renderRunItems(container, run) {
  container.textContent = "";
  const items = run?.items;
  if (!items || (!items.protected?.length && !items.conflicts?.length)) return;
  // The conflicts are a subset of the protected edits (the source changed too): one row each
  const id = (r) => `${r.kind} ${r.key} ${r.scope ?? ""} ${r.env ?? ""}`;
  const conflictIds = new Set((items.conflicts ?? []).map(id));
  const rows = new Map();
  for (const r of [...(items.protected ?? []), ...(items.conflicts ?? [])]) if (!rows.has(id(r))) rows.set(id(r), r);
  const row = (r, conflict) => el("tr", {},
    el("td", { class: "key" }, r.key, r.kind === "segment" ? el("span", { class: "chip" }, "segment") : null),
    el("td", {}, r.scope === "environment" ? `environment ${r.env ?? ""}` : r.scope === "flag" ? "flag-level fields" : r.scope ?? (r.env ? `environment ${r.env}` : "—")),
    el("td", {}, conflict ? syncBadge("conflict", "differs") : "no"));
  const t = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Item"), el("th", {}, "Left as it is"), el("th", { title: "Whether the source changed too, so its change was not applied" }, "Source changed too"))),
    el("tbody", {}, [...rows.values()].map((r) => row(r, conflictIds.has(id(r)) || r.sourceChanged === true))));
  const n = rows.size;
  container.append(el("details", { class: "run-items" },
    el("summary", {}, run.dryRun
      ? `The dry run found ${n} edit${n === 1 ? "" : "s"} in B that a real run would leave as ${n === 1 ? "it is" : "they are"}`
      : `The last run left ${n} edit${n === 1 ? "" : "s"} in B as ${n === 1 ? "it is" : "they are"}`),
    el("div", { class: "table-wrap" }, t)));
}
