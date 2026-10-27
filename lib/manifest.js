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

const isVersion = (v) => v === undefined || Number.isInteger(v);
const isKey = (v) => v === undefined || (typeof v === "string" && v !== "");

/** The first malformed field of a manifest entry, as a path, or null. Omitted fields are fine (older manifests). */
function badEntryField(entry, kind) {
  if (!isObj(entry)) return "";
  if (!isVersion(entry.version)) return ".version";
  if (!isKey(entry.destKey)) return ".destKey";
  if (entry.extraDestKeys !== undefined && !(Array.isArray(entry.extraDestKeys) && entry.extraDestKeys.every(isKey))) return ".extraDestKeys";
  if (entry.dest !== undefined) {
    if (!isObj(entry.dest) || !isVersion(entry.dest.version)) return ".dest.version";
    if (entry.dest.since !== undefined && !Number.isFinite(entry.dest.since)) return ".dest.since";
    if (entry.dest.environments !== undefined) {
      if (!isObj(entry.dest.environments)) return ".dest.environments";
      for (const [env, e] of Object.entries(entry.dest.environments)) {
        if (!isObj(e) || !isVersion(e.version)) return `.dest.environments.${env}.version`;
      }
    }
  }
  if (kind === "flag") {
    if (entry.environments !== undefined) {
      if (!isObj(entry.environments)) return ".environments";
      for (const [env, e] of Object.entries(entry.environments)) {
        if (!isObj(e) || !isVersion(e.version)) return `.environments.${env}.version`;
      }
    }
    const owned = entry.targetOwned;
    if (owned !== undefined && !(isObj(owned) && (owned.environments === undefined || (Array.isArray(owned.environments) && owned.environments.every((e) => typeof e === "string"))))) {
      return ".targetOwned";
    }
  } else if (entry.targetOwned !== undefined && entry.targetOwned !== "edited" && entry.targetOwned !== "deleted") {
    return ".targetOwned";
  }
  return null;
}

/** Validates a parsed sync manifest. Throws on something that is not one; returns warnings for gaps. */
export function parseManifest(json) {
  if (!isObj(json) || !isObj(json.flags) || typeof json.sourceProject !== "string" || typeof json.destProject !== "string") {
    throw new Error("not a sync manifest (expected sourceProject, destProject and flags)");
  }
  for (const [key, entry] of Object.entries(json.flags)) {
    const bad = badEntryField(entry, "flag");
    if (bad !== null) throw new Error(`malformed sync manifest: flags.${key}${bad}`);
  }
  if (json.segments !== undefined && !isObj(json.segments)) throw new Error("malformed sync manifest: segments");
  for (const [env, entries] of Object.entries(json.segments ?? {})) {
    if (!isObj(entries)) throw new Error(`malformed sync manifest: segments.${env}`);
    for (const [key, entry] of Object.entries(entries)) {
      const bad = badEntryField(entry, "segment");
      if (bad !== null) throw new Error(`malformed sync manifest: segments.${env}.${key}${bad}`);
    }
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
  for (const [env, dest] of Object.entries(json.envMap)) {
    if (typeof dest !== "string" || dest === "") throw new Error(`malformed run record: envMap.${env}`);
  }
  for (const field of ["protected", "conflicts"]) {
    const list = json[field];
    if (list !== undefined && !(Array.isArray(list) && list.every((r) => isObj(r) && typeof r.key === "string"))) {
      throw new Error(`malformed run record: ${field}`);
    }
  }
  const warnings = [];
  if (!RUN_RECORD_SCHEMA_VERSIONS.includes(json.schemaVersion)) {
    warnings.push(`Run record schema version ${json.schemaVersion} is newer than this tool knows (${RUN_RECORD_SCHEMA_VERSIONS.join(", ")}); some fields may be ignored.`);
  }
  if (json.dryRun) warnings.push("The run record is from a dry run; the manifest is from the last real run, so the run's environment mapping is not used.");
  else if (json.manifestWritten === false) warnings.push("The run did not write the manifest; its environment mapping is not used.");
  return { run: json, warnings };
}

/**
 * Destination keys the manifest records, for pairing A and B: flags by source key, segments by
 * "<envA>/<key>". An entry without destKey was copied under its source key (as migrate reads it),
 * so it maps to itself and --key-prefix does not apply to it.
 */
export function destKeysFromManifest(manifest) {
  const flags = new Map();
  for (const [key, entry] of Object.entries(manifest?.flags ?? {})) {
    flags.set(key, entry?.destKey ?? key);
  }
  const segments = new Map();
  for (const [env, entries] of Object.entries(manifest?.segments ?? {})) {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      segments.set(`${env}/${key}`, entry?.destKey ?? key);
    }
  }
  return { flags, segments };
}

/**
 * Why the manifest does not describe this check (other projects, or another destination instance),
 * or null when it does. A mismatched manifest must not pair keys or relabel findings.
 */
export function manifestMismatch(manifest, { projectA, projectB, baseUrlB }) {
  if (manifest.sourceProject !== projectA || manifest.destProject !== projectB) {
    return `The manifest is for ${manifest.sourceProject} → ${manifest.destProject}, this check for ${projectA} → ${projectB}.`;
  }
  if (manifest.destDomain && baseUrlB && hostOf(baseUrlB) !== hostOf(manifest.destDomain)) {
    return `The manifest was written for ${manifest.destDomain}, side B is ${baseUrlB}.`;
  }
  return null;
}

/**
 * Whether the run that wrote this record also wrote the manifest. A dry run (or a run that stopped
 * before writing it) still updates runs/latest-*.json, but its environment mapping says nothing
 * about what the manifest covers, so it neither picks the environments nor marks any as cut over.
 */
export function runRecordWroteManifest(runRecord) {
  return !runRecord.dryRun && runRecord.manifestWritten !== false;
}

const invalidated = (entry) => entry.version === 0;

/** Why the run record does not belong to the manifest, or null when it does. */
export function runRecordMismatch(runRecord, manifest) {
  if (runRecord.source?.projectKey !== manifest.sourceProject || runRecord.destination?.projectKey !== manifest.destProject) {
    return "The run record and the manifest are for different projects; the run record is ignored.";
  }
  const domain = runRecord.destination?.domain;
  if (domain && manifest.destDomain && hostOf(domain) !== hostOf(manifest.destDomain)) {
    return `The run record is for ${domain}, the manifest for ${manifest.destDomain}; the run record is ignored.`;
  }
  // migrate stamps the same start time on the run record and the manifest it writes
  const started = ms(runRecord.startedAt), manifestStarted = ms(manifest.lastRunStartedAt);
  if (runRecordWroteManifest(runRecord) && started !== undefined && manifestStarted !== undefined && started !== manifestStarted) {
    return `The run record (${runRecord.startedAt}) is not from the run that wrote the manifest (${manifest.lastRunStartedAt}); the run record is ignored.`;
  }
  return null;
}

function hostOf(urlOrHost) {
  try {
    return new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).host.toLowerCase();
  } catch {
    return String(urlOrHost).toLowerCase();
  }
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
  const mismatch = manifestMismatch(manifest, {
    projectA: report.sides.a.projectKey,
    projectB: report.sides.b.projectKey,
    baseUrlB: report.sides.b.baseUrl,
  });
  if (mismatch) {
    // Another project's versions say nothing about this one: keep every finding as it is
    out.sync = { manifest: manifestSummary(manifest), run: null, cutOver: [], counts: { flags: {}, segments: {} }, ignored: true, warnings: [`${mismatch} The manifest is ignored.`] };
    return out;
  }
  if (runRecord && runRecordMismatch(runRecord, manifest)) {
    warnings.push(runRecordMismatch(runRecord, manifest));
    runRecord = null;
  }
  const lastSync = ms(manifest.lastSyncTimestamp);
  const lastStart = ms(manifest.lastRunStartedAt) ?? lastSync;
  // Entries without a recorded destination state are judged against the end of the last run before
  // ld-migration-scripts 3.6.0 (legacyEditCutoff), as migrate does; B edits after it are B's
  const editCutoff = ms(manifest.legacyEditCutoff) ?? lastSync;
  // A copy migrate could not read back after writing it carries its own cutoff (dest.since, epoch ms)
  const cutoffFor = (entry) => (Number.isFinite(entry.dest?.since) ? entry.dest.since : editCutoff);
  const cutOver = runRecord && runRecordWroteManifest(runRecord)
    ? report.envMap.filter((p) => own(runRecord.envMap, p.a) !== p.b)
    : [];
  const isCutOver = (pair) => cutOver.some((c) => c.a === pair.a && c.b === pair.b);
  // migrate records the source version it saw even where it left a destination edit alone, so a
  // conflict of the last run no longer shows in the versions; take it from the run record
  const runConflicts = runRecord && runRecordWroteManifest(runRecord) ? runRecord.conflicts ?? [] : [];
  const hadConflict = (kind, key, scope, env) =>
    runConflicts.some((c) => c.kind === kind && c.key === key && (scope === undefined || c.scope === scope) && (env === undefined || c.env === env));
  const counts = { flags: {}, segments: {} };
  const bump = (bucket, state) => (bucket[state] = (bucket[state] ?? 0) + 1);

  for (const f of out.flags) {
    if (f.status === "extraInB") continue;
    const recordedFlag = own(manifest.flags, f.key);
    const notes = [];
    let state;
    // A failed write resets the entry's source version to 0 so the next run retries it: no baseline
    const entry = recordedFlag && !invalidated(recordedFlag) ? recordedFlag : undefined;
    if (recordedFlag && !entry) {
      state = f.status === "identical" ? "inSync" : "untracked";
      f.sync = { state };
      notes.push("The last sync of this flag failed; the manifest has no baseline for it.");
    } else if (!entry) {
      // A flag created after the last run started has simply not been synced yet
      const created = ms(f.createdA);
      state = f.status === "missingInB" && created !== undefined && lastStart !== undefined && created > lastStart
        ? "pendingSource"
        : f.status === "identical" ? "inSync" : "untracked";
      f.sync = { state };
      if (f.status === "missingInB") f.severity = SEVERITY_FOR[state] ?? f.severity;
    } else if (f.status === "missingInB") {
      // Deleted in B; if A changed since too, that change has nowhere to go
      const sourceChanged = hadConflict("flag", f.key, "deleted") || (f.versionA !== undefined && f.versionA !== entry.version) ||
        out.envMap.some((p) => {
          const recordedA = own(entry.environments, p.a)?.version;
          return !isCutOver(p) && recordedA !== undefined && f.envVersionsA?.[p.a] !== undefined && f.envVersionsA[p.a] !== recordedA;
        });
      state = sourceChanged ? "conflict" : "editedInTarget";
      f.sync = { state, deleted: true };
      f.severity = SEVERITY_FOR[state];
      notes.push(sourceChanged
        ? "Deleted in B after the migration created it, and changed in A since; the migration does not recreate it."
        : "Deleted in B after the migration created it; the migration does not recreate it.");
    } else {
      const owned = entry.targetOwned ?? {};
      const environments = {};
      let anyTargetEnv = false;
      for (const pair of out.envMap) {
        const label = `${pair.a}→${pair.b}`;
        const versionA = f.envVersionsA?.[pair.a];
        const recordedA = own(entry.environments, pair.a)?.version;
        // A copy deleted in B and recreated there is B's in every environment
        const ownedHere = Boolean(owned.deleted) || Boolean(owned.environments?.includes(pair.b));
        // An environment the migration never synced for this flag (nor B owns) has no baseline
        if (recordedA === undefined && !ownedHere && !isCutOver(pair)) {
          environments[label] = "untracked";
          continue;
        }
        const sourceChanged = (versionA !== undefined && versionA !== recordedA) || hadConflict("flag", f.key, "environment", pair.b);
        const recordedB = own(entry.dest?.environments, pair.b);
        const versionB = f.envVersionsB?.[pair.b];
        const modifiedB = f.envModifiedB?.[pair.b];
        const targetChanged = ownedHere ||
          (recordedB?.version !== undefined
            ? versionB !== undefined && versionB !== recordedB.version
            : cutoffFor(entry) !== undefined && modifiedB !== undefined && modifiedB > cutoffFor(entry));
        if (targetChanged) anyTargetEnv = true;
        // A cut-over environment's targeting is no longer synced, but an edit there still keeps the
        // flag-level fields as they are
        environments[label] = isCutOver(pair) ? "cutOver" : stateOf(sourceChanged, targetChanged);
      }
      // Any edited environment keeps the flag-level fields as they are, too (as migrate does)
      // Any destination-owned environment counts, compared here or not (migrate protects them all)
      const flagTarget = Boolean(owned.flag) || Boolean(owned.deleted) || anyTargetEnv || Boolean(owned.environments?.length) ||
        (entry.dest?.version !== undefined && f.versionB !== undefined && f.versionB !== entry.dest.version);
      const flagSource = (f.versionA !== undefined && f.versionA !== entry.version) || hadConflict("flag", f.key, "flag");
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
    const recorded = own(own(manifest.segments, s.envA), s.key);
    // An entry recorded for another destination environment has no baseline for this pair
    const entry = recorded && !invalidated(recorded) && (recorded.destEnv === undefined || recorded.destEnv === s.envB) ? recorded : undefined;
    let state;
    if (isCutOver({ a: s.envA, b: s.envB })) state = "cutOver";
    else if (!entry) {
      // A segment created after the last run started has simply not been synced yet
      const created = ms(s.createdA);
      state = s.status === "missingInB" && created !== undefined && lastStart !== undefined && created > lastStart
        ? "pendingSource"
        : s.status === "identical" ? "inSync" : "untracked";
    } else if (s.status === "missingInB") {
      state = hadConflict("segment", s.key, undefined, s.envB) || (s.versionA !== undefined && s.versionA !== entry.version) ? "conflict" : "editedInTarget";
    } else {
      const sourceChanged = (s.versionA !== undefined && s.versionA !== entry.version) || hadConflict("segment", s.key, undefined, s.envB);
      const targetChanged = Boolean(entry.targetOwned) ||
        (entry.dest?.version !== undefined
          ? s.versionB !== undefined && s.versionB !== entry.dest.version
          : cutoffFor(entry) !== undefined && ms(s.updatedB) !== undefined && ms(s.updatedB) > cutoffFor(entry));
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
    manifest: manifestSummary(manifest),
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

function manifestSummary(manifest) {
  return {
    lastSyncTimestamp: manifest.lastSyncTimestamp ?? null,
    lastRunStartedAt: manifest.lastRunStartedAt ?? null,
    sourceProject: manifest.sourceProject,
    destProject: manifest.destProject,
    destDomain: manifest.destDomain ?? null,
    flagsTracked: Object.keys(manifest.flags).length,
    segmentsTracked: Object.values(manifest.segments ?? {}).reduce((n, e) => n + Object.keys(e ?? {}).length, 0),
    incomplete: manifest.incomplete?.reason ?? null,
  };
}
