import { assertEquals } from "@std/assert";
import { normalizeEnvConfig, normalizeFlagLevel, normalizeTargets } from "../lib/normalize_flag.js";
import { isEqual } from "../lib/deep_diff.js";
import { flagA, flagBIdentical } from "./fixtures/flags.js";

Deno.test("targets and contextTargets merge into one sorted set", () => {
  const t = normalizeTargets(
    [{ values: ["b", "a"], variation: 0 }],
    [{ contextKind: "user", values: [], variation: 0 }, { contextKind: "org", values: ["acme"], variation: 1 }],
  );
  assertEquals(t, [
    { contextKind: "org", variation: 1, values: ["acme"] },
    { contextKind: "user", variation: 0, values: ["a", "b"] },
  ]);
});

Deno.test("flag level: ids, versions, timestamps, duplicate tags, whitespace are normalized away", () => {
  const a = normalizeFlagLevel(flagA);
  const b = normalizeFlagLevel(flagBIdentical);
  assertEquals(a.tags, ["checkout", "frontend"]);
  assertEquals(a.description, "New checkout flow");
  assertEquals(a.maintainerEmail, "dev@example.com");
  assertEquals(isEqual(a, b), true);
});

Deno.test("environment config: migrated env equals source env", () => {
  const a = normalizeEnvConfig(flagA.environments.prod);
  const b = normalizeEnvConfig(flagBIdentical.environments.production);
  assertEquals(isEqual(a, b), true);
  assertEquals(a.rules[1].rollout.variations, [{ variation: 0, weight: 70000 }, { variation: 1, weight: 30000 }]);
  assertEquals(isEqual(normalizeEnvConfig(flagA.environments.dev), normalizeEnvConfig(flagBIdentical.environments.development)), true);
});

Deno.test("includeInSnippet-only flags map to clientSideAvailability", () => {
  const n = normalizeFlagLevel({ key: "x", includeInSnippet: true });
  assertEquals(n.clientSideAvailability, { usingEnvironmentId: true, usingMobileKey: null });
});
