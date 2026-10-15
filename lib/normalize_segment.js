// Canonicalize a LaunchDarkly segment (GET /api/v2/segments/{proj}/{env} item).

import { normalizeClause, USER_KIND } from "./normalize_flag.js";

const sortStrings = (arr) => [...(Array.isArray(arr) ? arr : [])].map(String).sort();

function normalizeContextTargets(list) {
  const map = new Map();
  for (const t of list ?? []) {
    const ck = t.contextKind ?? USER_KIND;
    const set = map.get(ck) ?? new Set();
    for (const v of t.values ?? []) set.add(String(v));
    map.set(ck, set);
  }
  return [...map.entries()]
    .filter(([, s]) => s.size > 0)
    .map(([contextKind, s]) => ({ contextKind, values: [...s].sort() }))
    .sort((x, y) => x.contextKind.localeCompare(y.contextKind));
}

function normalizeSegmentRule(r) {
  const hasWeight = r.weight !== undefined && r.weight !== null;
  return {
    description: r.description ?? "",
    clauses: (r.clauses ?? []).map(normalizeClause),
    weight: hasWeight ? r.weight : null,
    rolloutContextKind: hasWeight ? (r.rolloutContextKind ?? USER_KIND) : null,
    bucketBy: hasWeight ? (r.bucketBy ?? null) : null,
  };
}

export function normalizeSegment(seg) {
  const unbounded = Boolean(seg.unbounded);
  return {
    key: seg.key,
    name: seg.name ?? "",
    description: (seg.description ?? "").trim(),
    tags: [...new Set(seg.tags ?? [])].sort(),
    unbounded,
    unboundedContextKind: unbounded ? (seg.unboundedContextKind ?? USER_KIND) : null,
    // Legacy user lists + context lists merged the same way flags merge targets.
    includedContexts: normalizeContextTargets([
      ...(seg.included?.length ? [{ contextKind: USER_KIND, values: seg.included }] : []),
      ...(seg.includedContexts ?? []),
    ]),
    excludedContexts: normalizeContextTargets([
      ...(seg.excluded?.length ? [{ contextKind: USER_KIND, values: seg.excluded }] : []),
      ...(seg.excludedContexts ?? []),
    ]),
    rules: (seg.rules ?? []).map(normalizeSegmentRule),
  };
}

export { sortStrings };
