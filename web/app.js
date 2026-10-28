import { makeClient } from "../lib/ld_api.js";
import { compareProjects } from "../lib/compare.js";
import { listFindings, meaningGroups, parseReport, toMarkdown } from "../lib/report.js";
import { annotateWithManifest, checkSyncInputs, destKeysFromManifest, parseManifest, parseRunRecord, runRecordWroteManifest, SYNC_STATE_LABELS, SYNC_STATES } from "../lib/manifest.js";
import { el, inState, SYNC_SHORT, renderErrors, renderFindings, renderFlags, renderLists, renderMeaning, renderRunItems, renderSegments, renderStateTabs, renderStatus, renderSummary, renderSyncLine, renderVerdict, SORTS } from "./render.js";
import { detectHost, initialView, probeConsole, VIEWS } from "./env.js";

const $ = (sel) => document.querySelector(sel);
const form = $("#form");
const state = {
  clients: {}, envs: { a: [], b: [] }, report: null, abort: null, flagState: "active", sort: null,
  host: "local", view: "operator",
  // Parsed migration-state files (operator view): { json, name } or null
  manifest: null, runRecord: null,
};

// --- where the page runs, and the view (drift check or migration operator) ---
const VIEW_KEY = "ld-sync-check-view";
const savedView = () => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } };
state.host = await detectHost({ hostname: location.hostname, probe: () => probeConsole() });
document.body.dataset.host = state.host;
function applyView(view) {
  state.view = view;
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll("#view-switch [data-view-id]")) b.setAttribute("aria-selected", String(b.dataset.viewId === view));
  if (state.report) render();
}
for (const b of document.querySelectorAll("#view-switch [data-view-id]")) {
  b.addEventListener("click", () => {
    if (!VIEWS.includes(b.dataset.viewId)) return;
    try { localStorage.setItem(VIEW_KEY, b.dataset.viewId); } catch { /* storage unavailable */ }
    applyView(b.dataset.viewId);
  });
}
applyView(initialView({ host: state.host, search: location.search, saved: savedView() }));
const operator = () => state.view === "operator";

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
    for (const k of ["a-host", "a-project", "a-token", "b-host", "b-project", "b-token"]) data[k] = form.elements[k].value;
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

// --- check options persistence (no secrets, so localStorage across reloads and tabs) ---
const OPTS_KEY = "ld-sync-check-options";
const OPTION_FIELDS = ["include-archived", "compare-maintainers", "strict-extra", "key-prefix"];
function restoreOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "null");
    if (!saved) return;
    for (const k of OPTION_FIELDS) {
      const f = form.elements[k];
      if (!(k in saved)) continue;
      if (f.type === "checkbox") f.checked = Boolean(saved[k]);
      else f.value = String(saved[k]);
    }
  } catch { /* storage unavailable */ }
}
function persistOptions() {
  try {
    const data = {};
    for (const k of OPTION_FIELDS) { const f = form.elements[k]; data[k] = f.type === "checkbox" ? f.checked : f.value; }
    localStorage.setItem(OPTS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}
form.addEventListener("change", persistOptions);
restoreOptions();

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
  // The migration state and the operator-only options apply in the operator view only
  const useSync = operator() && state.manifest;
  let sync = { manifest: null, runRecord: null, warnings: [] };
  if (useSync) {
    try {
      sync = await checkSyncInputs({
        manifestJson: state.manifest.json, runRecordJson: state.runRecord?.json ?? null,
        projectA, projectB, baseUrlB: clientB.baseUrl,
        accountB: () => clientB.callerIdentity().then((who) => who?.accountId),
      });
    } catch (err) {
      progress.textContent = `Failed: ${err.message}`;
      return;
    }
  }
  const startedAt = Date.now();
  state.abort = new AbortController();
  clientA = makeClient({ baseUrl: clientA.baseUrl, token: form.elements["a-token"].value.trim(), signal: state.abort.signal });
  clientB = makeClient({ baseUrl: clientB.baseUrl, token: form.elements["b-token"].value.trim(), signal: state.abort.signal });
  cancel.onclick = () => state.abort.abort();
  try {
    let report = await compareProjects({
      clientA, clientB, projectA, projectB, envMap,
      labels: { a: labelFor(clientA.baseUrl), b: labelFor(clientB.baseUrl) },
      options: {
        includeArchived: form.elements["include-archived"].checked,
        compareMaintainers: form.elements["compare-maintainers"].checked,
        strictExtra: operator() && form.elements["strict-extra"].checked,
        keyPrefix: operator() ? form.elements["key-prefix"].value.trim() : "",
      },
      onProgress,
      destKeys: sync.manifest ? destKeysFromManifest(sync.manifest) : null,
    });
    if (sync.manifest) {
      report = annotateWithManifest(report, sync.manifest, sync.runRecord);
      report.sync.warnings.unshift(...sync.warnings);
    }
    state.report = report;
    state.loadedFrom = null;
    progress.textContent = `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`;
    state.flagState = "active";
    state.sort = null;
    show();
  } catch (err) {
    progress.textContent = err.name === "AbortError" ? "Cancelled." : `Failed: ${err.message}`;
  } finally {
    run.disabled = false; cancel.hidden = true;
  }
});

const labelFor = (u) => (u.includes(".eu.") ? "EU" : u.includes("launchdarkly.com") ? "US" : u.replace(/^https?:\/\//, ""));

function show() {
  render();
  $("#results").scrollIntoView({ behavior: "smooth" });
}
/** Renders state.report for the current view. */
function render() {
  const report = state.report;
  $("#results").hidden = false;
  const loaded = $("#loaded");
  loaded.hidden = !state.loadedFrom;
  if (state.loadedFrom) {
    loaded.textContent = `Showing ${state.loadedFrom}: ${report.sides.a.projectKey} (${report.sides.a.label}) → ${report.sides.b.projectKey} (${report.sides.b.label}), generated ${new Date(report.generatedAt).toLocaleString()}. Run the check above for a current result.`;
  }
  const groups = meaningGroups(report);
  renderVerdict($("#verdict"), report, groups);
  renderMeaning($("#meaning"), report, groups);
  const sync = report.sync && !report.sync.ignored ? report.sync : null;
  renderSyncLine($("#sync-line"), $("#sync-warnings"), report.sync ?? null);
  renderRunItems($("#run-items"), sync?.run ?? null);
  renderSyncFilter(sync);
  renderStatus($("#status"), report, (sev) => {
    const d = $(`#findings details[data-sev="${sev}"]`);
    d.open = !d.open;
    if (d.open) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  renderFindings($("#findings"), listFindings(report));
  renderSummary($("#summary"), report, (status) => {
    $("#status-filter").value = $("#status-filter").value === status ? "" : status;
    if (status === "extraInB" || status === "missingInB") state.flagState = "all";
    applyFilter();
    $("#flags").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  applyFilter();
  renderSegments($("#segments"), report.segments, withSync());
  renderErrors($("#errors"), report.errors);
}
const withSync = () => operator() && Boolean(state.report?.sync) && !state.report.sync.ignored;
function renderSyncFilter(sync) {
  const select = $("#sync-filter");
  const current = select.value;
  select.textContent = "";
  select.append(el("option", { value: "" }, "all"));
  for (const s of SYNC_STATES) {
    const n = sync?.counts.flags[s] ?? 0;
    if (n) select.append(el("option", { value: s, selected: s === current, title: SYNC_STATE_LABELS[s] }, `${SYNC_SHORT[s]} (${n})`));
  }
  $("#sync-filter-label").hidden = !sync;
}
/** @param {string} [refocus] selector of a re-rendered control to focus afterwards */
function applyFilter(refocus) {
  const report = state.report;
  if (!report) return;
  const q = $("#filter").value.trim().toLowerCase();
  const st = $("#status-filter").value;
  const syncState = withSync() ? $("#sync-filter").value : "";
  // Search + result filter first; the state tabs count what those leave.
  const matching = report.flags.filter((f) => {
    if (st && f.status !== st) return false;
    if (syncState && f.sync?.state !== syncState) return false;
    if (!q) return true;
    if (f.key.toLowerCase().includes(q)) return true;
    return [...f.flagLevel, ...Object.values(f.environments).flat()].some((e) => e.path.toLowerCase().includes(q));
  });
  const archivedFetched = report.options.includeArchived;
  renderStateTabs($("#state-tabs"), matching, state.flagState, archivedFetched, (id) => { state.flagState = id; applyFilter(`#state-tabs [data-state="${id}"]`); });
  const rows = matching.filter(inState(state.flagState));
  renderLists($("#lists"), report.flags.filter(inState(state.flagState)));
  renderFlags($("#flags"), {
    flags: rows, sides: report.sides, sort: state.sort, state: state.flagState, archivedFetched, countEl: $("#count"), withSync: withSync(),
    onSort: (key) => {
      const s = state.sort;
      state.sort = s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: SORTS[key].firstDir };
      applyFilter(`#flags th [data-sort="${key}"]`);
    },
  });
  // Re-rendering replaces the tab and sort buttons; put keyboard focus back on the one used.
  if (refocus) $(refocus)?.focus();
}
$("#filter").addEventListener("input", () => applyFilter());
$("#status-filter").addEventListener("change", () => applyFilter());
$("#sync-filter").addEventListener("change", () => applyFilter());

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#dl-json").addEventListener("click", () => state.report && download(`sync-report-${state.report.generatedAt}.json`, JSON.stringify(state.report, null, 2), "application/json"));
$("#dl-md").addEventListener("click", () => state.report && download(`sync-report-${state.report.generatedAt}.md`, toMarkdown(state.report), "text/markdown"));

// --- files: a shared report (both views), the manifest and run record (operator view) ---
async function readJsonFile(input) {
  const file = input.files?.[0];
  if (!file) return null;
  try {
    return { name: file.name, json: JSON.parse(await file.text()) };
  } finally {
    input.value = ""; // the same file can be picked again after a change on disk
  }
}
const utcText = (iso) => (iso ? `${iso.slice(0, 16).replace("T", " ")}Z` : "unknown");

$("#open-report").addEventListener("change", async (ev) => {
  const status = $("#open-report-status");
  try {
    const file = await readJsonFile(ev.target);
    if (!file) return;
    state.report = parseReport(file.json);
    state.loadedFrom = file.name;
    status.textContent = "";
    state.flagState = "active";
    state.sort = null;
    show();
  } catch (err) {
    status.textContent = `Could not open it: ${err.message}`;
  }
});

function showSyncFiles() {
  const m = state.manifest, r = state.runRecord;
  $("#manifest-status").textContent = m
    ? `${m.name}: ${m.json.sourceProject} → ${m.json.destProject}, last sync ${utcText(m.json.lastSyncTimestamp)}, ${Object.keys(m.json.flags).length} flags tracked`
    : "";
  $("#run-record-status").textContent = r
    ? `${r.name}: ${r.json.mode ?? "run"} ${utcText(r.json.startedAt)}${r.json.dryRun ? " (dry run: its environment mapping is not used)" : ""}`
    : "";
  $("#clear-sync").hidden = !m && !r;
}
$("#manifest-file").addEventListener("change", async (ev) => {
  try {
    const file = await readJsonFile(ev.target);
    if (!file) return;
    parseManifest(file.json);
    state.manifest = file;
    // The manifest names the projects; fill them in when they are still empty
    for (const [side, key] of [["a", file.json.sourceProject], ["b", file.json.destProject]]) {
      if (!form.elements[`${side}-project`].value.trim()) form.elements[`${side}-project`].value = key;
    }
    showSyncFiles();
  } catch (err) {
    // The file picked replaces the one before, even when it is unusable
    state.manifest = null;
    showSyncFiles();
    $("#manifest-status").textContent = `Not used: ${err.message}`;
  }
});
$("#run-record-file").addEventListener("change", async (ev) => {
  try {
    const file = await readJsonFile(ev.target);
    if (!file) return;
    parseRunRecord(file.json);
    state.runRecord = file;
    // The run's environment mapping is the natural one to compare, when that run wrote the manifest
    if (runRecordWroteManifest(file.json)) {
      envmap.textContent = "";
      for (const [a, b] of Object.entries(file.json.envMap)) addRow(a, b);
    }
    showSyncFiles();
  } catch (err) {
    // The file picked replaces the one before, even when it is unusable
    state.runRecord = null;
    showSyncFiles();
    $("#run-record-status").textContent = `Not used: ${err.message}`;
  }
});
$("#clear-sync").addEventListener("click", () => {
  state.manifest = null;
  state.runRecord = null;
  showSyncFiles();
});
