// DOM builders. Everything from the API goes through textContent, never innerHTML.

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

export function renderStatus(container, report) {
  const s = report.summary;
  container.textContent = "";
  container.className = `status ${s.status}`;
  const icon = { pass: "✅", warn: "⚠️", fail: "❌" }[s.status];
  container.append(`${icon} ${s.status.toUpperCase()} · `, el("span", { style: "font-weight:400;font-size:15px" }, `${s.counts.error} errors, ${s.counts.warning} warnings, ${s.counts.info} info · ${new Date(report.generatedAt).toLocaleString()}`));
}

export function renderSummary(container, report) {
  const f = report.summary.flags;
  container.textContent = "";
  const card = (n, l, cls) => el("div", { class: `card ${cls ?? ""}` }, el("div", { class: "n" }, n), el("div", { class: "l" }, l));
  container.append(
    card(f.a, `flags in A (${report.sides.a.label})`),
    card(f.b, `flags in B (${report.sides.b.label})`),
    card(f.identical, "identical", "ok"),
    card(f.differing, "differing", f.differing ? "err" : "ok"),
    card(f.missingInB, "missing in B", f.missingInB ? "err" : "ok"),
    card(f.extraInB, "only in B", f.extraInB ? "warn" : "ok"),
  );
  for (const [env, g] of Object.entries(report.summary.segments)) {
    container.append(card(`${g.identical}/${g.a}`, `segments identical · ${env}`, g.identical === g.a && g.extraInB === 0 ? "ok" : "err"));
  }
}

export function renderLists(container, report) {
  container.textContent = "";
  const missing = report.flags.filter((x) => x.status === "missingInB");
  const extra = report.flags.filter((x) => x.status === "extraInB");
  if (missing.length) container.append(el("div", { class: "list" }, el("strong", {}, `Missing in B (${missing.length}): `), missing.map((x) => el("code", {}, x.key))));
  if (extra.length) container.append(el("div", { class: "list" }, el("strong", {}, `Only in B (${extra.length}): `), extra.map((x) => el("code", {}, x.key))));
}

function diffTable(entries) {
  const t = el("table", { class: "diff" }, el("thead", {}, el("tr", {}, el("th", {}, "Path"), el("th", {}, "A"), el("th", {}, "B"), el("th", {}, "Severity"))));
  const body = el("tbody");
  for (const e of entries) body.append(el("tr", {}, el("td", {}, el("code", {}, e.path)), el("td", {}, el("code", {}, show(e.a))), el("td", {}, el("code", {}, show(e.b))), el("td", {}, badge(e.severity))));
  t.append(body);
  return t;
}

function flagDetail(f) {
  const d = el("div");
  if (f.flagLevel.length) d.append(el("h4", {}, "Flag level"), diffTable(f.flagLevel));
  for (const [env, entries] of Object.entries(f.environments)) if (entries.length) d.append(el("h4", {}, `Environment ${env}`), diffTable(entries));
  if (!f.flagLevel.length && !Object.values(f.environments).some((e) => e.length)) d.append(el("p", { class: "notes" }, f.status === "identical" ? "No differences." : "No field-level details."));
  if (f.notes.length) d.append(el("ul", { class: "notes" }, f.notes.map((n) => el("li", {}, n))));
  return d;
}

export function renderFlags(container, flags, countEl) {
  container.textContent = "";
  countEl.textContent = `${flags.length} flag(s)`;
  const t = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Flag key"), el("th", {}, "Status"), el("th", {}, "Severity"), el("th", {}, "Findings"))));
  const body = el("tbody");
  for (const f of flags) {
    const n = f.flagLevel.length + Object.values(f.environments).reduce((a, e) => a + e.length, 0);
    const detail = el("tr", { class: "detail", hidden: true }, el("td", { colspan: 4 }, flagDetail(f)));
    const row = el("tr", { class: "row", onclick: () => { detail.hidden = !detail.hidden; } },
      el("td", { class: "key" }, f.key, f.archived ? " (archived)" : ""),
      el("td", {}, badge(f.status)),
      el("td", {}, badge(f.severity)),
      el("td", {}, n ? `${n} field(s)` : "", f.notes.length ? ` · ${f.notes.length} note(s)` : ""),
    );
    body.append(row, detail);
  }
  t.append(body);
  container.append(t);
}

export function renderSegments(container, segments) {
  container.textContent = "";
  if (!segments.length) { container.append(el("p", { class: "notes" }, "No segments in the compared environments.")); return; }
  const t = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Segment"), el("th", {}, "Environments"), el("th", {}, "Status"), el("th", {}, "Severity"))));
  const body = el("tbody");
  for (const s of segments) {
    const detail = el("tr", { class: "detail", hidden: true }, el("td", { colspan: 4 }, s.diffs.length ? diffTable(s.diffs) : el("p", { class: "notes" }, "No differences."), s.notes.length ? el("ul", { class: "notes" }, s.notes.map((n) => el("li", {}, n))) : null));
    body.append(
      el("tr", { class: "row", onclick: () => { detail.hidden = !detail.hidden; } }, el("td", { class: "key" }, s.key), el("td", {}, `${s.envA} → ${s.envB}`), el("td", {}, badge(s.status)), el("td", {}, badge(s.severity))),
      detail,
    );
  }
  t.append(body);
  container.append(t);
}

export function renderErrors(container, errors) {
  container.textContent = "";
  if (!errors.length) return;
  container.append(el("div", { class: "errbox" }, el("strong", {}, "Some requests failed; the report is incomplete."), el("ul", {}, errors.map((e) => el("li", {}, `${e.context ?? ""} HTTP ${e.status}: ${e.message}`)))));
}
