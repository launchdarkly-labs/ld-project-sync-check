// Sync state of each difference, from the sync manifest and run record that ld-migration-scripts
// (≥ 3.6.0) writes after every migrate run:
//
//   data/launchdarkly-migrations/sync-manifest-<source>-<dest>.json   cumulative inventory
//   data/launchdarkly-migrations/runs/latest-<source>-<dest>.json     the last run
//
// The manifest records, per migrated flag and segment, the source version the migration last
// synced and the state it left the destination copy in (`dest`), plus what the migration found
// edited in the destination since (`targetOwned`). A rerun never overwrites a destination edit.
// With it, every difference can be told apart:
//
//   pendingSource   A changed after the last sync; the next sync applies it       → info
//   editedInTarget  B changed (or was deleted) after the last sync; the migration
//                   leaves it as it is, so it stays different by design            → info
//   conflict        both changed; the source change will not be applied           → warning
//   cutOver         the environment is no longer synced (dropped from the run's
//                   environment mapping after its cutover)                        → info
//   untracked       not in the manifest (never migrated); the difference stands   → unchanged
//   inSync          neither side changed since the last sync; the difference is
//                   unexplained                                                    → unchanged
//
// Versions are compared, not fingerprints: a B version bump that changed nothing the migration
// writes shows as editedInTarget here, while migrate itself only protects real content edits.

import { worst } from "./severity.js";
import { summarize } from "./report.js";

export const MANIFEST_TOOL_MIN_VERSION = "3.6.0";
export const RUN_RECORD_SCHEMA_VERSIONS = [1];

export const SYNC_STATES = ["conflict", "editedInTarget", "pendingSource", "cutOver", "untracked", "inSync"];

export const SYNC_STATE_LABELS = {
  pendingSource: "waiting for the next sync",
  editedInTarget: "changed in B after the last sync (left as it is)",
  conflict: "changed on both sides (source change not applied)",
  cutOver: "environment cut over (no longer synced)",
  untracked: "not tracked by the migration",
  inSync: "unexplained difference",
};

const SEVERITY_FOR = { pendingSource: "info", editedInTarget: "info", cutOver: "info", conflict: "warning" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates a parsed sync manifest. Throws on something that is not one; returns warnings for gaps. */
export function parseManifest(json) {
  if (!isObj(json) || !isObj(json.flags) || typeof json.sourceProject !== "string" || typeof json.destProject !== "string") {
    throw new Error("not a sync manifest (expected sourceProject, destProject and flags)");
  }
  const warnings = [];
  const entries = Object.values(json.flags);
  if (entries.length && !entries.some((e) => isObj(e?.dest))) {
    warnings.push(`The manifest has no destination records (written before ld-migration-scripts ${MANIFEST_TOOL_MIN_VERSION}); target edits are judged by B's last-modified time against the last sync.`);
  }
  if (json.incomplete) warnings.push(`The manifest is marked incomplete: ${json.incomplete.reason ?? "the last run stopped early"}.`);
  return { manifest: json, warnings };
}

/** Validates a parsed run record. Throws on something that is not one; returns warnings. */
export function parseRunRecord(json) {
  if (!isObj(json) || typeof json.schemaVersion !== "number" || typeof json.startedAt !== "string" || !isObj(json.envMap)) {
    throw new Error("not a run record (expected schemaVersion, startedAt and envMap)");
  }
  const warnings = [];
  if (!RUN_RECORD_SCHEMA_VERSIONS.includes(json.schemaVersion)) {
    warnings.push(`Run record schema version ${json.schemaVersion} is newer than this tool knows (${RUN_RECORD_SCHEMA_VERSIONS.join(", ")}); some fields may be ignored.`);
  }
  if (json.dryRun) warnings.push("The run record is from a dry run; the manifest is from the last real run.");
  return { run: json, warnings };
}

/** Destination keys the manifest records, for pairing A and B: flags by source key, segments by "<envA>/<key>". */
export function destKeysFromManifest(manifest) {
  const flags = new Map();
  for (const [key, entry] of Object.entries(manifest?.flags ?? {})) {
    if (entry?.destKey) flags.set(key, entry.destKey);
  }
  const segments = new Map();
  for (const [env, entries] of Object.entries(manifest?.segments ?? {})) {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      if (entry?.destKey) segments.set(`${env}/${key}`, entry.destKey);
    }
  }
  return { flags, segments };
}

const ms = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : undefined;
};

const own = (record, key) => (record && Object.hasOwn(record, key) ? record[key] : undefined);

function combine(states) {
  for (const s of SYNC_STATES) if (states.includes(s)) return s;
  return "inSync";
}

function stateOf(sourceChanged, targetChanged) {
  if (sourceChanged && targetChanged) return "conflict";
  if (targetChanged) return "editedInTarget";
  if (sourceChanged) return "pendingSource";
  return "inSync";
}

function relabel(entries, state) {
  const sev = SEVERITY_FOR[state];
  return sev ? entries.map((e) => ({ ...e, severity: sev === "warning" && e.severity === "info" ? "info" : sev })) : entries;
}

/**
 * The report with a `sync` block and, on each flag and segment result, a `sync` state; severities
 * follow the state (see the header). The summary is recomputed. The input report is not modified.
 */
export function annotateWithManifest(report, manifest, runRecord = null) {
  const out = structuredClone(report);
  const warnings = [];
  if (manifest.sourceProject !== report.sides.a.projectKey || manifest.destProject !== report.sides.b.projectKey) {
    warnings.push(`The manifest is for ${manifest.sourceProject} → ${manifest.destProject}, this check for ${report.sides.a.projectKey} → ${report.sides.b.projectKey}.`);
  }
  if (manifest.destDomain && report.sides.b.baseUrl && !report.sides.b.baseUrl.includes(manifest.destDomain)) {
    warnings.push(`The manifest was written for ${manifest.destDomain}, side B is ${report.sides.b.baseUrl}.`);
  }
  if (runRecord && (runRecord.source?.projectKey !== manifest.sourceProject || runRecord.destination?.projectKey !== manifest.destProject)) {
    warnings.push("The run record and the manifest are for different projects; the run record is ignored.");
    runRecord = null;
  }
  const lastSync = ms(manifest.lastSyncTimestamp);
  const lastStart = ms(manifest.lastRunStartedAt) ?? lastSync;
  const cutOver = runRecord
    ? report.envMap.filter((p) => own(runRecord.envMap, p.a) !== p.b)
    : [];
  const isCutOver = (pair) => cutOver.some((c) => c.a === pair.a && c.b === pair.b);
  const counts = { flags: {}, segments: {} };
  const bump = (bucket, state) => (bucket[state] = (bucket[state] ?? 0) + 1);

  for (const f of out.flags) {
    if (f.status === "extraInB") continue;
    const entry = own(manifest.flags, f.key);
    const notes = [];
    let state;
    if (!entry) {
      // A flag created after the last run started has simply not been synced yet
      const created = ms(f.createdA);
      state = f.status === "missingInB" && created !== undefined && lastStart !== undefined && created > lastStart
        ? "pendingSource"
        : f.status === "identical" ? "inSync" : "untracked";
      f.sync = { state };
      if (f.status === "missingInB") f.severity = SEVERITY_FOR[state] ?? f.severity;
    } else if (f.status === "missingInB") {
      state = "editedInTarget";
      f.sync = { state, deleted: true };
      f.severity = "info";
      notes.push("Deleted in B after the migration created it; the migration does not recreate it.");
    } else {
      const owned = entry.targetOwned ?? {};
      const environments = {};
      let anyTargetEnv = false;
      for (const pair of out.envMap) {
        const label = `${pair.a}→${pair.b}`;
        if (isCutOver(pair)) {
          environments[label] = "cutOver";
          continue;
        }
        const versionA = f.envVersionsA?.[pair.a];
        const recordedA = own(entry.environments, pair.a)?.version;
        const sourceChanged = versionA !== undefined && versionA !== recordedA;
        const recordedB = own(entry.dest?.environments, pair.b);
        const versionB = f.envVersionsB?.[pair.b];
        const modifiedB = f.envModifiedB?.[pair.b];
        const targetChanged = Boolean(owned.environments?.includes(pair.b)) ||
          (recordedB?.version !== undefined
            ? versionB !== undefined && versionB !== recordedB.version
            : lastSync !== undefined && modifiedB !== undefined && modifiedB > lastSync);
        if (targetChanged) anyTargetEnv = true;
        environments[label] = stateOf(sourceChanged, targetChanged);
      }
      // Any edited environment keeps the flag-level fields as they are, too (as migrate does)
      const flagTarget = Boolean(owned.flag) || anyTargetEnv ||
        (entry.dest?.version !== undefined && f.versionB !== undefined && f.versionB !== entry.dest.version);
      const flagSource = f.versionA !== undefined && f.versionA !== entry.version;
      const flagLevel = f.flagLevel.length ? stateOf(flagSource, flagTarget) : "inSync";
      f.flagLevel = relabel(f.flagLevel, flagLevel);
      for (const [label, entries] of Object.entries(f.environments)) {
        f.environments[label] = relabel(entries, environments[label] ?? "inSync");
      }
      const withDiffs = [
        ...(f.flagLevel.length ? [flagLevel] : []),
        ...Object.entries(f.environments).filter(([, e]) => e.length).map(([l]) => environments[l] ?? "inSync"),
      ];
      state = combine(withDiffs);
      f.sync = { state, flagLevel, environments };
      const all = [...f.flagLevel, ...Object.values(f.environments).flat()];
      f.severity = worst(all);
      for (const [label, s] of Object.entries(environments)) {
        if (s !== "inSync" && f.environments[label]?.length) notes.push(`${label}: ${SYNC_STATE_LABELS[s]}.`);
      }
      if (f.flagLevel.length && flagLevel !== "inSync") notes.push(`Flag level: ${SYNC_STATE_LABELS[flagLevel]}.`);
    }
    f.notes = [...notes, ...f.notes];
    bump(counts.flags, f.sync.state);
  }

  for (const s of out.segments) {
    if (s.status === "extraInB") continue;
    const entry = own(own(manifest.segments, s.envA), s.key);
    let state;
    if (isCutOver({ a: s.envA, b: s.envB })) state = "cutOver";
    else if (!entry) state = s.status === "identical" ? "inSync" : "untracked";
    else if (s.status === "missingInB") state = "editedInTarget";
    else {
      const sourceChanged = s.versionA !== undefined && s.versionA !== entry.version;
      const targetChanged = Boolean(entry.targetOwned) ||
        (entry.dest?.version !== undefined
          ? s.versionB !== undefined && s.versionB !== entry.dest.version
          : lastSync !== undefined && ms(s.updatedB) !== undefined && ms(s.updatedB) > lastSync);
      state = stateOf(sourceChanged, targetChanged);
    }
    s.sync = { state, ...(entry && s.status === "missingInB" ? { deleted: true } : {}) };
    s.diffs = relabel(s.diffs, state);
    if (s.status === "missingInB") s.severity = SEVERITY_FOR[state] ?? s.severity;
    else s.severity = worst(s.diffs);
    if (state !== "inSync" && s.status !== "identical") s.notes = [`${SYNC_STATE_LABELS[state]}.`, ...s.notes];
    bump(counts.segments, state);
  }

  out.sync = {
    manifest: {
      lastSyncTimestamp: manifest.lastSyncTimestamp ?? null,
      lastRunStartedAt: manifest.lastRunStartedAt ?? null,
      sourceProject: manifest.sourceProject,
      destProject: manifest.destProject,
      destDomain: manifest.destDomain ?? null,
      flagsTracked: Object.keys(manifest.flags).length,
      segmentsTracked: Object.values(manifest.segments ?? {}).reduce((n, e) => n + Object.keys(e ?? {}).length, 0),
      incomplete: manifest.incomplete?.reason ?? null,
    },
    run: runRecord
      ? {
        startedAt: runRecord.startedAt,
        finishedAt: runRecord.finishedAt ?? null,
        mode: runRecord.mode ?? null,
        dryRun: Boolean(runRecord.dryRun),
        toolVersion: runRecord.toolVersion ?? null,
        exitCode: runRecord.exitCode ?? null,
        counts: runRecord.counts ?? null,
        protected: (runRecord.protected ?? []).length,
        conflicts: (runRecord.conflicts ?? []).length,
      }
      : null,
    cutOver,
    counts,
    warnings,
  };
  out.summary = { ...summarize(out), flags: out.summary.flags };
  return out;
}
