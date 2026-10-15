// Compare the server-side SDK payloads two environments serve (what SDKs actually receive).
//
// Either give SDK keys directly:
//   LD_SDK_KEY_A=sdk-... LD_SDK_KEY_B=sdk-... deno task sdk-diff --a-sdk-url https://sdk.launchdarkly.com --b-sdk-url https://sdk.eu.launchdarkly.com
// or let the tool read them from the environments via REST tokens:
//   LD_TOKEN_A=... LD_TOKEN_B=... deno task sdk-diff --a-project p --env-map production:production

import { HOSTS, makeClient } from "../lib/ld_api.js";
import { diffSdkPayloads, fetchSdkPayload, sdkDiffToMarkdown } from "../lib/sdk_payload.js";
import { loadConfig, parse, parseEnvMap, writeOut } from "./_common.js";

const SDK_HOSTS = { us: "https://sdk.launchdarkly.com", eu: "https://sdk.eu.launchdarkly.com" };
const args = parse({
  string: ["a-url", "b-url", "a-sdk-url", "b-sdk-url", "a-project", "b-project", "env-map", "out", "config"],
  boolean: ["help"],
  default: { out: "out" },
});
if (args.help) {
  console.log(`Usage: deno task sdk-diff [--a-sdk-url U] [--b-sdk-url U] [--a-project p --env-map a:b,...]
SDK keys: LD_SDK_KEY_A / LD_SDK_KEY_B, or resolved from the environments using LD_TOKEN_A / LD_TOKEN_B.`);
  Deno.exit(0);
}
const cfg = await loadConfig(args.config);
const aSdk = args["a-sdk-url"] ?? cfg.aSdkUrl ?? SDK_HOSTS.us;
const bSdk = args["b-sdk-url"] ?? cfg.bSdkUrl ?? SDK_HOSTS.eu;

let pairs;
if (Deno.env.get("LD_SDK_KEY_A") && Deno.env.get("LD_SDK_KEY_B")) {
  pairs = [{ envA: "A", envB: "B", keyA: Deno.env.get("LD_SDK_KEY_A"), keyB: Deno.env.get("LD_SDK_KEY_B") }];
} else {
  const projectA = args["a-project"] ?? cfg.aProject;
  const projectB = args["b-project"] ?? cfg.bProject ?? projectA;
  const envMap = parseEnvMap(args["env-map"]) ?? (Array.isArray(cfg.envMap) ? cfg.envMap : parseEnvMap(cfg.envMap));
  const tokenA = cfg.tokenA ?? Deno.env.get("LD_TOKEN_A");
  const tokenB = cfg.tokenB ?? Deno.env.get("LD_TOKEN_B");
  if (!projectA || !envMap || !tokenA || !tokenB) { console.error("Error: need LD_SDK_KEY_A/B, or --a-project, --env-map and LD_TOKEN_A/B"); Deno.exit(64); }
  const ca = makeClient({ baseUrl: args["a-url"] ?? cfg.aUrl ?? HOSTS.us, token: tokenA });
  const cb = makeClient({ baseUrl: args["b-url"] ?? cfg.bUrl ?? HOSTS.eu, token: tokenB });
  pairs = await Promise.all(envMap.map(async (m) => {
    const [ea, eb] = await Promise.all([ca.getEnvironment(projectA, m.a), cb.getEnvironment(projectB, m.b)]);
    return { envA: m.a, envB: m.b, keyA: ea.apiKey, keyB: eb.apiKey };
  }));
}

let failed = false;
for (const p of pairs) {
  const [pa, pb] = await Promise.all([fetchSdkPayload(p.keyA, aSdk), fetchSdkPayload(p.keyB, bSdk)]);
  const result = diffSdkPayloads(pa, pb);
  const md = sdkDiffToMarkdown(result, { envA: p.envA, envB: p.envB, baseA: aSdk, baseB: bSdk });
  console.log(md);
  await writeOut(args.out, `sdk-diff-${p.envA}-${p.envB}.md`, md);
  await writeOut(args.out, `sdk-diff-${p.envA}-${p.envB}.json`, JSON.stringify(result, null, 2));
  for (const s of Object.values(result)) if (s.changed || s.onlyInA.length || s.onlyInB.length) failed = true;
}
Deno.exit(failed ? 1 : 0);
