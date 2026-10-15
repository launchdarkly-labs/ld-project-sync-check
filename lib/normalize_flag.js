// Canonicalize a LaunchDarkly feature flag (REST shape, GET /api/v2/flags/{proj}?summary=false)
// into exactly the fields the LD->LD migration tool writes, so "identical" means
// "the migration produced what it was supposed to". Everything server-generated or
// instance-specific (_id, _links, salt, sel, version, timestamps, _site, _summary...) is dropped.

import { sortKeysDeep } from "./deep_diff.js";

export const USER_KIND = "user";

const uniqSorted = (arr) => [...new Set(Array.isArray(arr) ? arr : [])].sort();
const sortStrings = (arr) => [...(Array.isArray(arr) ? arr : [])].map(String).sort();

/** Merge `targets` (legacy user targets) and `contextTargets` into one canonical list. */
export function normalizeTargets(targets, contextTargets) {
  const map = new Map();
  for (const t of [...(targets ?? []), ...(contextTargets ?? [])]) {
    const contextKind = t.contextKind ?? USER_KIND;
    const key = `${contextKind}\u0000${t.variation}`;
    const set = map.get(key) ?? new Set();
    for (const v of t.values ?? []) set.add(String(v));
    map.set(key, set);
  }
  return [...map.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([key, set]) => {
      const [contextKind, variation] = key.split("\u0000");
      return { contextKind, variation: Number(variation), values: [...set].sort() };
    })
    .sort((x, y) => x.contextKind.localeCompare(y.contextKind) || x.variation - y.variation);
}

export function normalizeClause(c) {
  return {
    contextKind: c.contextKind ?? USER_KIND,
    attribute: c.attribute,
    op: c.op,
    values: (c.values ?? []).map(sortKeysDeep),
    negate: Boolean(c.negate),
  };
}

export function normalizeRollout(r) {
  const out = {
    contextKind: r.contextKind ?? USER_KIND,
    bucketBy: r.bucketBy ?? null,
    variations: (r.variations ?? [])
      .map((v) => ({ variation: v.variation, weight: v.weight }))
      .sort((x, y) => x.variation - y.variation),
  };
  if (r.seed !== undefined && r.seed !== null) out.seed = r.seed;
  if (r.experimentAllocation) out.experimentAllocation = sortKeysDeep(r.experimentAllocation);
  return out;
}

/** A rule or fallthrough serves either a fixed variation or a rollout. */
export function normalizeServe(x) {
  if (x && x.rollout) return { rollout: normalizeRollout(x.rollout) };
  return { variation: x && x.variation !== undefined ? x.variation : null };
}

export function normalizeRule(r) {
  return {
    description: r.description ?? "",
    ...normalizeServe(r),
    clauses: (r.clauses ?? []).map(normalizeClause),
    trackEvents: Boolean(r.trackEvents),
    ref: r.ref ?? null,
  };
}

export function normalizePrerequisites(prereqs) {
  return (prereqs ?? [])
    .map((p) => ({ key: p.key, variation: p.variation }))
    .sort((x, y) => x.key.localeCompare(y.key));
}

/** Environment-level targeting configuration. */
export function normalizeEnvConfig(env) {
  if (!env) return null;
  return {
    on: Boolean(env.on),
    archived: Boolean(env.archived),
    offVariation: env.offVariation ?? null,
    fallthrough: normalizeServe(env.fallthrough ?? {}),
    rules: (env.rules ?? []).map(normalizeRule),
    targets: normalizeTargets(env.targets, env.contextTargets),
    prerequisites: normalizePrerequisites(env.prerequisites),
    trackEvents: Boolean(env.trackEvents),
    trackEventsFallthrough: Boolean(env.trackEventsFallthrough),
  };
}

function clientSideAvailability(flag) {
  if (flag.clientSideAvailability) {
    return {
      usingEnvironmentId: Boolean(flag.clientSideAvailability.usingEnvironmentId),
      usingMobileKey: Boolean(flag.clientSideAvailability.usingMobileKey),
    };
  }
  if ("includeInSnippet" in flag) {
    return { usingEnvironmentId: Boolean(flag.includeInSnippet), usingMobileKey: null };
  }
  return { usingEnvironmentId: false, usingMobileKey: null };
}

function customProperties(cp) {
  const out = {};
  for (const key of Object.keys(cp ?? {}).sort()) {
    const p = cp[key] ?? {};
    out[key] = { name: p.name ?? key, value: (p.value ?? []).map(String) };
  }
  return out;
}

/** Flag-level (project-wide) definition, independent of environments. */
export function normalizeFlagLevel(flag) {
  return {
    key: flag.key,
    kind: flag.kind ?? null,
    name: flag.name ?? "",
    description: (flag.description ?? "").trim(),
    temporary: Boolean(flag.temporary),
    tags: uniqSorted(flag.tags),
    variations: (flag.variations ?? []).map((v) => ({
      value: sortKeysDeep(v.value),
      name: v.name ?? null,
      description: v.description ?? null,
    })),
    defaults: flag.defaults
      ? { onVariation: flag.defaults.onVariation ?? null, offVariation: flag.defaults.offVariation ?? null }
      : null,
    archived: Boolean(flag.archived),
    deprecated: Boolean(flag.deprecated),
    deprecatedDate: flag.deprecatedDate ?? null,
    clientSideAvailability: clientSideAvailability(flag),
    customProperties: customProperties(flag.customProperties),
    variationJsonSchema: flag.variationJsonSchema ? sortKeysDeep(flag.variationJsonSchema) : null,
    // Informational paths (severity table maps these to "info"):
    maintainerEmail: (flag._maintainer?.email ?? "").toLowerCase() || null,
    maintainerTeamKey: flag.maintainerTeamKey ?? null,
    experiments: flag.experiments?.items?.length ?? 0,
    goalIds: sortStrings(flag.goalIds),
    viewKeys: sortStrings(flag.viewKeys),
    purpose: flag.purpose ?? flag._purpose ?? null,
    migrationSettings: flag.migrationSettings ? sortKeysDeep(flag.migrationSettings) : null,
  };
}

/**
 * Full normalization. `envKeys` selects which environments to keep (source-side keys).
 * Returns { key, flagLevel, environments: { [envKey]: normalizedEnvConfig | null } }.
 */
export function normalizeFlag(flag, envKeys) {
  const environments = {};
  for (const k of envKeys) environments[k] = normalizeEnvConfig(flag.environments?.[k]);
  return { key: flag.key, flagLevel: normalizeFlagLevel(flag), environments };
}
