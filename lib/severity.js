// Maps a diff path to a severity. One table shared by flags and segments so the
// report is consistent. First matching rule wins; default is "error".

const RULES = [
  // Flag-level, warning: cosmetic or instance-dependent
  [/^deprecatedDate$/, "warning"],
  [/^variationJsonSchema/, "warning"],
  [/^clientSideAvailability\.usingMobileKey$/, "warning"],
  // Rule refs are optional labels, not evaluated
  [/(^|\.)rules\[\d+\]\.ref$/, "warning"],
  // Informational: differ between instances by design or not migrated by the tool
  [/^maintainerEmail$/, "info"],
  [/^maintainerTeamKey$/, "info"],
  [/^experiments/, "info"],
  [/^goalIds/, "info"],
  [/^viewKeys/, "info"],
  [/^purpose$/, "info"],
  [/^migrationSettings/, "info"],
];

export const SEVERITIES = ["error", "warning", "info"];

export function classify(path) {
  for (const [re, sev] of RULES) if (re.test(path)) return sev;
  return "error";
}

/** Highest severity in a list of diff entries ("none" when empty). */
export function worst(entries) {
  let w = "none";
  for (const e of entries) {
    const s = e.severity ?? classify(e.path);
    if (s === "error") return "error";
    if (s === "warning") w = "warning";
    else if (s === "info" && w === "none") w = "info";
  }
  return w;
}

export function withSeverity(entries) {
  return entries.map((e) => ({ ...e, severity: classify(e.path) }));
}
