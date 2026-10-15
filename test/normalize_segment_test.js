import { assertEquals } from "@std/assert";
import { normalizeSegment } from "../lib/normalize_segment.js";
import { isEqual } from "../lib/deep_diff.js";
import { segmentA, segmentBIdentical } from "./fixtures/flags.js";

Deno.test("segments: legacy included list and includedContexts compare equal", () => {
  const a = normalizeSegment(segmentA);
  const b = normalizeSegment(segmentBIdentical);
  assertEquals(a.includedContexts, [
    { contextKind: "org", values: ["acme"] },
    { contextKind: "user", values: ["u1", "u2"] },
  ]);
  assertEquals(isEqual(a, b), true);
});

Deno.test("big segments keep shape, flag unbounded", () => {
  const n = normalizeSegment({ key: "big", unbounded: true, rules: [] });
  assertEquals(n.unbounded, true);
  assertEquals(n.unboundedContextKind, "user");
});
