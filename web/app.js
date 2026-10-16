import { makeClient } from "../lib/ld_api.js";
import { compareProjects } from "../lib/compare.js";
import { toMarkdown } from "../lib/report.js";
import { el, inState, renderErrors, renderFlags, renderLists, renderSegments, renderStateTabs, renderStatus, renderSummary, SORTS } from "./render.js";

const $ = (sel) => document.querySelector(sel);
const form = $("#form");
const state = { clients: {}, envs: { a: [], b: [] }, report: null, abort: null, flagState: "active", sort: null };

// --- token persistence (opt-in, sessionStorage only) ---
const KEY = "ld-sync-check";
function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (!saved) return;
    for (const [k, v] of Object.entries(saved)) if (form.elements[k]) form.elements[k].value = v;
    form.elements.remember.checked = true;
  } catch { /* storage unavailable */ }
}
function persist() {
  try {
    if (!form.elements.remember.checked) { sessionStorage.removeItem(KEY); return; }
    const data = {};
    for (const k of ["a-host", "a-project", "a-token", "b-host", "b-project", "b-token", "key-prefix"]) data[k] = form.elements[k].value;
    sessionStorage.setItem(KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}
$("#forget").addEventListener("click", () => {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  form.elements["a-token"].value = "";
  form.elements["b-token"].value = "";
  form.elements.remember.checked = false;
});
form.addEventListener("change", persist);
restore();

// --- connect: validate token, load environments ---
function clientFor(side) {
  const baseUrl = form.elements[`${side}-host`].value;
  const token = form.elements[`${side}-token`].value.trim();
  if (!token) throw new Error("token missing");
  return makeClient({ baseUrl, token });
}
async function connect(side) {
  const out = document.querySelector(`.conn[data-side="${side}"]`);
  const setConn = (cls, text) => { out.textContent = ""; out.append(el("span", { class: `dot ${cls}`, "aria-hidden": "true" }), text); };
  setConn("busy", "Connecting…");
  try {
    const client = clientFor(side);
    const project = form.elements[`${side}-project`].value.trim();
    const [who, envs] = await Promise.all([client.callerIdentity(), client.listEnvironments(project)]);
    state.clients[side] = client;
    state.envs[side] = envs.map((e) => e.key);
    setConn("ok", `Connected as ${who.tokenName ?? who.memberEmail ?? who.accountId ?? "token"} · ${envs.length} environment(s): ${state.envs[side].join(", ")}`);
    rebuildEnvMap();
  } catch (err) {
    setConn("err", `Failed: ${err.message}${err.status === 401 || err.status === 403 ? " (check the token and its project access)" : ""}`);
  }
}
document.querySelectorAll(".connect").forEach((b) => b.addEventListener("click", () => connect(b.dataset.side)));
for (const side of ["a", "b"]) {
  form.elements[`${side}-project`].addEventListener("change", () => { if (form.elements[`${side}-token`].value) connect(side); });
}

// --- env mapping rows ---
const envmap = $("#envmap");
function envSelect(side, value) {
  const s = el("select", { "data-side": side });
  s.append(el("option", { value: "" }, "—"));
  for (const k of state.envs[side]) s.append(el("option", { value: k, selected: k === value }, k));
  if (value && !state.envs[side].includes(value)) s.append(el("option", { value, selected: true }, value));
  return s;
}
function addRow(a = "", b = "") {
  const row = el("div", { class: "envrow" }, envSelect("a", a), el("span", { class: "arrow" }, "→"), envSelect("b", b), el("button", { type: "button", class: "ghost", onclick: () => row.remove() }, "✕"));
  envmap.append(row);
}
function currentEnvMap() {
  return [...envmap.querySelectorAll(".envrow")].map((r) => {
    const [a, b] = [...r.querySelectorAll("select")].map((s) => s.value);
    return { a, b };
  }).filter((m) => m.a && m.b);
}
function rebuildEnvMap() {
  const existing = currentEnvMap();
  envmap.textContent = "";
  if (existing.length) { for (const m of existing) addRow(m.a, m.b); }
  else if (state.envs.a.length && state.envs.b.length) {
    const bSet = new Set(state.envs.b);
    const common = state.envs.a.filter((k) => bSet.has(k));
    for (const k of common) addRow(k, k);
    if (!common.length) addRow();
  } else addRow();
}
$("#add-row").addEventListener("click", () => addRow());
addRow();

// --- run ---
const progress = $("#progress");
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const envMap = currentEnvMap();
  if (!envMap.length) { progress.textContent = "Add at least one environment pair."; return; }
  const projectA = form.elements["a-project"].value.trim();
  const projectB = form.elements["b-project"].value.trim();
  let clientA, clientB;
  try { clientA = clientFor("a"); clientB = clientFor("b"); } catch (err) { progress.textContent = err.message; return; }
  const run = $("#run"), cancel = $("#cancel");
  run.disabled = true; cancel.hidden = false;
  const seen = {};
  const onProgress = (p) => {
    if (p.phase === "compare") { progress.textContent = "Comparing…"; return; }
    seen[`${p.phase} ${p.side.toUpperCase()}`] = p.total ? `${p.fetched}/${p.total}` : p.fetched;
    progress.textContent = Object.entries(seen).map(([k, v]) => `${k} ${v}`).join(" · ");
  };
  const startedAt = Date.now();
  state.abort = new AbortController();
  clientA = makeClient({ baseUrl: clientA.baseUrl, token: form.elements["a-token"].value.trim(), signal: state.abort.signal });
  clientB = makeClient({ baseUrl: clientB.baseUrl, token: form.elements["b-token"].value.trim(), signal: state.abort.signal });
  cancel.onclick = () => state.abort.abort();
  try {
    const report = await compareProjects({
      clientA, clientB, projectA, projectB, envMap,
      labels: { a: labelFor(clientA.baseUrl), b: labelFor(clientB.baseUrl) },
      options: {
        includeArchived: form.elements["include-archived"].checked,
        compareMaintainers: form.elements["compare-maintainers"].checked,
        strictExtra: form.elements["strict-extra"].checked,
        keyPrefix: form.elements["key-prefix"].value.trim(),
      },
      onProgress,
    });
    state.report = report;
    progress.textContent = `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`;
    show(report);
  } catch (err) {
    progress.textContent = err.name === "AbortError" ? "Cancelled." : `Failed: ${err.message}`;
  } finally {
    run.disabled = false; cancel.hidden = true;
  }
});

const labelFor = (u) => (u.includes(".eu.") ? "EU" : u.includes("launchdarkly.com") ? "US" : u.replace(/^https?:\/\//, ""));

function show(report) {
  $("#results").hidden = false;
  renderStatus($("#status"), report);
  renderSummary($("#summary"), report, (status) => {
    $("#status-filter").value = $("#status-filter").value === status ? "" : status;
    if (status === "extraInB" || status === "missingInB") state.flagState = "all";
    applyFilter();
    $("#flags").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  state.flagState = "active";
  state.sort = null;
  applyFilter();
  renderSegments($("#segments"), report.segments);
  renderErrors($("#errors"), report.errors);
  $("#results").scrollIntoView({ behavior: "smooth" });
}
function applyFilter() {
  const report = state.report;
  if (!report) return;
  const q = $("#filter").value.trim().toLowerCase();
  const st = $("#status-filter").value;
  // Search + result filter first; the state tabs count what those leave.
  const matching = report.flags.filter((f) => {
    if (st && f.status !== st) return false;
    if (!q) return true;
    if (f.key.toLowerCase().includes(q)) return true;
    return [...f.flagLevel, ...Object.values(f.environments).flat()].some((e) => e.path.toLowerCase().includes(q));
  });
  const archivedFetched = report.options.includeArchived;
  renderStateTabs($("#state-tabs"), matching, state.flagState, archivedFetched, (id) => { state.flagState = id; applyFilter(); });
  const rows = matching.filter(inState(state.flagState));
  renderLists($("#lists"), report.flags.filter(inState(state.flagState)));
  renderFlags($("#flags"), {
    flags: rows, sides: report.sides, sort: state.sort, state: state.flagState, archivedFetched, countEl: $("#count"),
    onSort: (key) => {
      const s = state.sort;
      state.sort = s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: SORTS[key].firstDir };
      applyFilter();
    },
  });
}
$("#filter").addEventListener("input", applyFilter);
$("#status-filter").addEventListener("change", applyFilter);

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#dl-json").addEventListener("click", () => state.report && download(`sync-report-${state.report.generatedAt}.json`, JSON.stringify(state.report, null, 2), "application/json"));
$("#dl-md").addEventListener("click", () => state.report && download(`sync-report-${state.report.generatedAt}.md`, toMarkdown(state.report), "text/markdown"));
