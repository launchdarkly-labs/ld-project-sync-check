import { assertEquals } from "@std/assert";
import { detectHost, initialView, probeConsole } from "../web/env.js";

Deno.test("GitHub Pages is hosted, without asking for a console", async () => {
  let probed = false;
  assertEquals(await detectHost({ hostname: "launchdarkly-labs.github.io", probe: () => { probed = true; return { console: true }; } }), "hosted");
  assertEquals(probed, false);
});

Deno.test("a console answers api/console; anything else is local", async () => {
  assertEquals(await detectHost({ hostname: "localhost", probe: () => Promise.resolve({ console: true }) }), "console");
  assertEquals(await detectHost({ hostname: "localhost", probe: () => Promise.reject(new Error("404")) }), "local");
  // A server that answers every path (with the page, say) is no console
  assertEquals(await detectHost({ hostname: "127.0.0.1", probe: () => Promise.resolve("<!doctype html>") }), "local");
  assertEquals(await detectHost({ hostname: "127.0.0.1", probe: () => Promise.resolve({ console: "yes" }) }), "local");
  assertEquals(await detectHost({ hostname: "localhost" }), "local");
});

Deno.test("probeConsole takes JSON only", async () => {
  const respond = (body, type, status = 200) => () => Promise.resolve(new Response(body, { status, headers: { "content-type": type } }));
  assertEquals(await probeConsole(respond('{"console":true}', "application/json")), { console: true });
  let failed = 0;
  for (const impl of [respond("<html>", "text/html"), respond("{}", "application/json", 404)]) await probeConsole(impl).catch(() => failed++);
  assertEquals(failed, 2);
});

Deno.test("the view: ?view= first, then the saved choice, then the host's default", () => {
  assertEquals(initialView({ host: "hosted" }), "drift");
  assertEquals(initialView({ host: "local" }), "operator");
  assertEquals(initialView({ host: "console" }), "operator");
  assertEquals(initialView({ host: "hosted", saved: "operator" }), "operator");
  assertEquals(initialView({ host: "local", saved: "operator", search: "?view=drift" }), "drift");
  assertEquals(initialView({ host: "hosted", saved: "bogus", search: "?view=bogus" }), "drift");
});
