// Canonical JSON and structural diff. Plain ES module: works in Deno and browsers.

/** Recursively sort object keys so JSON.stringify is order-independent. */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/** Canonical string form; two values are "identical" when their canonical forms match. */
export function canonical(value) {
  return JSON.stringify(sortKeysDeep(value === undefined ? null : value));
}

export function isEqual(a, b) {
  return canonical(a) === canonical(b);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Structural diff of two normalized values.
 * Returns [{ path, kind: "changed" | "addedInB" | "removedInB", a, b }].
 * Objects recurse by key; arrays recurse by index when both have the same length,
 * otherwise the whole array is reported as one change (array order is semantic for
 * variations and rules, so index alignment is the right comparison).
 */
export function diff(a, b, basePath = "") {
  const out = [];
  walk(a, b, basePath, out);
  return out;
}

function walk(a, b, path, out) {
  if (isEqual(a, b)) return;
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, kind: "addedInB", a: undefined, b: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: "removedInB", a: a[k], b: undefined });
      else walk(a[k], b[k], p, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  out.push({ path: path || "(root)", kind: "changed", a, b });
}
