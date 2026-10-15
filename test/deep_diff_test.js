import { assertEquals } from "@std/assert";
import { canonical, diff, isEqual } from "../lib/deep_diff.js";

Deno.test("canonical ignores key order", () => {
  assertEquals(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assertEquals(isEqual([1, { x: 1, y: 2 }], [1, { y: 2, x: 1 }]), true);
});

Deno.test("diff reports changed, added and removed paths", () => {
  const out = diff({ a: 1, b: { c: 2 }, arr: [1, 2] }, { a: 1, b: { c: 3, d: 4 }, arr: [1, 3], e: 5 });
  assertEquals(out.map((d) => [d.path, d.kind]), [
    ["arr[1]", "changed"],
    ["b.c", "changed"],
    ["b.d", "addedInB"],
    ["e", "addedInB"],
  ]);
});

Deno.test("arrays of different length are one change", () => {
  const out = diff({ rules: [{ a: 1 }] }, { rules: [{ a: 1 }, { a: 2 }] });
  assertEquals(out, [{ path: "rules", kind: "changed", a: [{ a: 1 }], b: [{ a: 1 }, { a: 2 }] }]);
});
