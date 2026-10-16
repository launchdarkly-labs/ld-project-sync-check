// Compare two LaunchDarkly projects (possibly on different instances) and produce a Report.

import { normalizeFlag } from "./normalize_flag.js";
import { normalizeSegment } from "./normalize_segment.js";
import { diff } from "./deep_diff.js";
import { withSeverity, worst } from "./severity.js";
import { summarize } from "./report.js";

export const REPORT_SCHEMA_VERSION = 1;
export const TOOL = { name: "ld-project-sync-check", version: "0.1.0" };

/**
 * @param {object} args
 * @param {object} args.clientA  client for side A (source / US)
 * @param {object} args.clientB  client for side B (target / EU)
 * @param {string} args.projectA
 * @param {string} args.projectB
 * @param {{a: string, b: string}[]} args.envMap  environment pairs to compare
 * @param {{a?: string, b?: string}} [args.labels]
 * @param {object} [args.options] { includeArchived, compareMaintainers, strictExtra, keyPrefix }
 * @param {(p: object) => void} [args.onProgress]
 */
export async function compareProjects({
  clientA,
  clientB,
  projectA,
  projectB,
  envMap,
  labels = {},
  options = {},
  onProgress = () => {},
}) {
  const opts = {
    includeArchived: Boolean(options.includeArchived),
    compareMaintainers: Boolean(options.compareMaintainers),
    strictExtra: Boolean(options.strictExtra),
    keyPrefix: options.keyPrefix ?? "",
  };
  const envsA = envMap.map((m) => m.a);
  const envsB = envMap.map((m) => m.b);
  const errors = [];
  const progress = (phase, side, fetched, total) => onProgress({ phase, side, fetched, total });

  // --- fetch flags (both sides in parallel) ---
  const fetchFlags = async (client, project, envs, side) => {
    const live = await client.listFlags(project, {
      envs,
      onPage: (n, t) => progress("flags", side, n, t),
    });
    let archived = [];
    if (opts.includeArchived) {
      archived = await client.listFlags(project, {
        envs,
        archived: true,
        onPage: (n, t) => progress("archived", side, n, t),
      });
    }
    return { live, archived };
  };
  const [fa, fb] = await Promise.all([
    fetchFlags(clientA, projectA, envsA, "a"),
    fetchFlags(clientB, projectB, envsB, "b"),
  ]);

  // --- fetch segments per env pair ---
  const segPairs = [];
  await Promise.all(
    envMap.map(async (pair) => {
      let sa = [], sb = [];
      try {
        [sa, sb] = await Promise.all([
          clientA.listSegments(projectA, pair.a, { onPage: (n, t) => progress("segments", "a", n, t) }),
          clientB.listSegments(projectB, pair.b, { onPage: (n, t) => progress("segments", "b", n, t) }),
        ]);
      } catch (err) {
        errors.push(apiErrorEntry(err, `segments ${pair.a}→${pair.b}`));
        return;
      }
      segPairs.push({ pair, sa, sb });
    }),
  );
  segPairs.sort((x, y) => envsA.indexOf(x.pair.a) - envsA.indexOf(y.pair.a));

  progress("compare", null, 0, 0);
  // Segment keys per A environment, so rules pointing at deleted segments can be recognized.
  const segmentKeysA = new Map(segPairs.map(({ pair, sa }) => [pair.a, new Set(sa.map((s) => s.key))]));
  const flags = compareFlags(fa, fb, envMap, opts, segmentKeysA);
  const segments = segPairs.flatMap(({ pair, sa, sb }) => compareSegments(sa, sb, pair, opts));

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: TOOL,
    sides: {
      a: { label: labels.a ?? "A", baseUrl: clientA.baseUrl, projectKey: projectA, envs: envsA },
      b: { label: labels.b ?? "B", baseUrl: clientB.baseUrl, projectKey: projectB, envs: envsB },
    },
    envMap,
    options: opts,
    summary: null,
    flags,
    segments,
    evaluation: [],
    errors,
  };
  report.summary = summarize(report, {
    archivedA: fa.archived.length,
    archivedB: fb.archived.length,
    totalA: fa.live.length + fa.archived.length,
    totalB: fb.live.length + fb.archived.length,
  });
  return report;
}

function apiErrorEntry(err, context) {
  return {
    context,
    status: err?.status ?? 0,
    url: err?.url ?? null,
    message: err?.message ?? String(err),
  };
}

const INFO_ONLY_KEYS = ["maintainerEmail"];

/**
 * @param {Map<string, Set<string>>} [segmentKeysA] segment keys per A environment; when given,
 *   rules in A that reference segments missing from A are recognized (see missingSegmentRules).
 */
export function compareFlags(fa, fb, envMap, opts, segmentKeysA = null) {
  const envsA = envMap.map((m) => m.a);
  const envsB = envMap.map((m) => m.b);
  const allA = [...fa.live.map((f) => [f, false]), ...fa.archived.map((f) => [f, true])];
  const allB = new Map();
  for (const f of fb.live) allB.set(f.key, { flag: f, archived: false });
  for (const f of fb.archived) allB.set(f.key, { flag: f, archived: true });

  const results = [];
  const seenB = new Set();
  for (const [a, archivedA] of allA) {
    const bKey = opts.keyPrefix + a.key;
    const bEntry = allB.get(bKey);
    if (!bEntry) {
      results.push({
        key: a.key,
        keyB: bKey,
        archived: archivedA,
        deprecated: Boolean(a.deprecated),
        ...sourceTimes(a, envsA),
        status: "missingInB",
        severity: "error",
        flagLevel: [],
        environments: {},
        notes: [],
      });
      continue;
    }
    seenB.add(bKey);
    const na = normalizeFlag(a, envsA);
    const nb = normalizeFlag(bEntry.flag, envsB);
    const flA = { ...na.flagLevel };
    const flB = { ...nb.flagLevel };
    delete flA.key;
    delete flB.key;
    if (!opts.compareMaintainers) for (const k of INFO_ONLY_KEYS) { delete flA[k]; delete flB[k]; }
    const flagLevel = withSeverity(diff(flA, flB));
    const environments = {};
    const notes = [];
    let droppedRules = 0;
    for (const pair of envMap) {
      const label = `${pair.a}→${pair.b}`;
      const ea = na.environments[pair.a];
      const eb = nb.environments[pair.b];
      if (!ea && !eb) continue;
      if (!ea || !eb) {
        environments[label] = [{
          path: "(environment)",
          kind: !eb ? "removedInB" : "addedInB",
          a: ea ? "present" : undefined,
          b: eb ? "present" : undefined,
          severity: "error",
        }];
        continue;
      }
      let entries = withSeverity(diff(ea, eb));
      const segKeys = segmentKeysA?.get(pair.a);
      const refs = segKeys ? missingSegmentRules(a.environments?.[pair.a]?.rules, segKeys) : [];
      const dead = refs.filter((r) => r.dead);
      if (dead.length) {
        // B can't hold these rules (the API rejects unknown segments). If B matches A without
        // them, report them as dropped (info) instead of a rules mismatch.
        const deadIdx = new Set(dead.map((r) => r.index));
        const alt = withSeverity(diff({ ...ea, rules: ea.rules.filter((_, i) => !deadIdx.has(i)) }, eb));
        if (alt.length < entries.length) {
          droppedRules += dead.length;
          entries = [...dead.map((r) => ({ path: `rules[${r.index}]`, kind: "droppedInB", a: r.summary, b: undefined, severity: "info" })), ...alt];
          for (const r of dead) {
            notes.push(`${pair.a}: rule ${r.label} references ${segList(r.missing)} that no longer exist${r.missing.length > 1 ? "" : "s"} in A. A rule like this can never match, and LaunchDarkly refuses to save rules that point at unknown segments, so it cannot be recreated in B. Leaving it out does not change evaluation.`);
          }
          if (alt.some((e) => e.path.startsWith("rules["))) notes.push(`${pair.a}: remaining rule differences are numbered as in B, i.e. after the dropped rule(s) were removed.`);
        }
      }
      for (const r of refs.filter((x) => !x.dead)) {
        if (!entries.some((e) => e.path.startsWith("rules"))) continue;
        notes.push(`${pair.a}: rule ${r.label} references ${segList(r.missing)} that no longer exist${r.missing.length > 1 ? "" : "s"} in A, but the rule is still live (${r.why}). B cannot reproduce it until the segment is recreated, so this difference is real.`);
      }
      environments[label] = entries;
    }
    if (na.flagLevel.experiments > 0) notes.push(`${na.flagLevel.experiments} experiment(s) attached in A; experiments are not migrated.`);
    if (na.flagLevel.maintainerTeamKey) notes.push(`Maintainer team "${na.flagLevel.maintainerTeamKey}" in A; team maintainers are not migrated.`);
    if (hasRollout(na)) notes.push("Uses percentage rollout(s); bucketing salt differs between instances, so individual context assignments may change.");
    if (archivedA !== bEntry.archived) notes.push(`Archived state differs: A ${archivedA}, B ${bEntry.archived}.`);
    const all = [...flagLevel, ...Object.values(environments).flat()];
    const sev = worst(all);
    results.push({
      key: a.key,
      keyB: bKey,
      archived: archivedA,
      archivedB: bEntry.archived,
      deprecated: Boolean(a.deprecated),
      droppedRules,
      ...sourceTimes(a, envsA),
      status: sev === "error" || sev === "warning" ? "differs" : "identical",
      severity: sev,
      flagLevel,
      environments,
      notes,
    });
  }
  for (const [key, entry] of allB) {
    if (seenB.has(key)) continue;
    results.push({
      key,
      keyB: key,
      archived: entry.archived,
      deprecated: Boolean(entry.flag.deprecated),
      createdA: null,
      updatedA: null,
      status: "extraInB",
      severity: opts.strictExtra ? "error" : "info",
      flagLevel: [],
      environments: {},
      notes: ["Present only in B."],
    });
  }
  results.sort((x, y) => rank(x) - rank(y) || x.key.localeCompare(y.key));
  return results;
}

const segList = (keys) => `segment${keys.length > 1 ? "s" : ""} ${keys.map((k) => `"${k}"`).join(", ")}`;

/**
 * Rules (raw REST shape) whose segmentMatch clauses reference segments not in `segKeys`.
 * `dead`: some non-negated segmentMatch clause lists only missing segments, so the clause (and,
 * clauses being AND'd, the rule) never matches; dropping the rule is evaluation-neutral.
 * Otherwise the rule is still live: a negated clause on a missing segment matches everyone, and
 * an OR'd existing segment can still match.
 */
export function missingSegmentRules(rules, segKeys) {
  const out = [];
  (rules ?? []).forEach((rule, index) => {
    const seg = (rule.clauses ?? []).filter((c) => c.op === "segmentMatch");
    const missing = [...new Set(seg.flatMap((c) => (c.values ?? []).filter((v) => !segKeys.has(v))))];
    if (!missing.length) return;
    const dead = seg.some((c) => !c.negate && c.values?.length && c.values.every((v) => !segKeys.has(v)));
    const negated = seg.some((c) => c.negate && c.values?.some((v) => !segKeys.has(v)));
    out.push({
      index,
      label: rule.description ? `"${rule.description}" (#${index + 1})` : `#${index + 1}`,
      missing,
      dead,
      why: negated ? "a negated clause on a missing segment matches every context" : "it is OR'd with a segment that still exists",
      summary: { description: rule.description ?? "", segmentMatch: missing },
    });
  });
  return out;
}

/** Side-A timestamps: creation, and the latest targeting change among the compared environments
 * (the flag API has no flag-level "last modified"). ISO strings or null. */
export function sourceTimes(flag, envKeys) {
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  const mods = envKeys.map((k) => flag.environments?.[k]?.lastModified).filter(Number.isFinite);
  return { createdA: iso(flag.creationDate), updatedA: mods.length ? iso(Math.max(...mods)) : null };
}

function hasRollout(nf) {
  return Object.values(nf.environments).some((e) =>
    e && (e.fallthrough.rollout || e.rules.some((r) => r.rollout))
  );
}

const ORDER = { missingInB: 0, differs: 1, extraInB: 2, identical: 3 };
const rank = (r) => ORDER[r.status] ?? 9;

export function compareSegments(sa, sb, pair, opts) {
  const bMap = new Map(sb.map((s) => [s.key, s]));
  const out = [];
  const seen = new Set();
  for (const a of sa) {
    const bKey = opts.keyPrefix + a.key;
    const b = bMap.get(bKey);
    const base = { envA: pair.a, envB: pair.b, key: a.key, keyB: bKey, notes: [] };
    if (!b) {
      out.push({ ...base, status: "missingInB", severity: "error", diffs: [] });
      continue;
    }
    seen.add(bKey);
    const na = normalizeSegment(a);
    const nb = normalizeSegment(b);
    delete na.key;
    delete nb.key;
    const diffs = withSeverity(diff(na, nb));
    if (na.unbounded) base.notes.push("Big segment: membership is not exposed via REST and is not compared here.");
    const sev = worst(diffs);
    out.push({ ...base, status: sev === "error" || sev === "warning" ? "differs" : "identical", severity: sev, diffs });
  }
  for (const [key] of bMap) {
    if (seen.has(key)) continue;
    out.push({
      envA: pair.a,
      envB: pair.b,
      key,
      keyB: key,
      status: "extraInB",
      severity: opts.strictExtra ? "error" : "info",
      diffs: [],
      notes: ["Present only in B."],
    });
  }
  out.sort((x, y) => rank(x) - rank(y) || x.key.localeCompare(y.key));
  return out;
}
