// Inventory a project's resources with emphasis on what the migration does not carry.
//   LD_TOKEN=api-... deno task inventory --url https://app.launchdarkly.com --project my-project --envs development,staging,production

import { HOSTS, makeClient } from "../lib/ld_api.js";
import { inventoryProject, inventoryToMarkdown } from "../lib/inventory.js";
import { loadConfig, parse, stderr, writeOut } from "./_common.js";

const args = parse({ string: ["url", "project", "envs", "out", "config", "token"], boolean: ["help"], default: { out: "out" } });
if (args.help) {
  console.log(`Usage: deno task inventory --project <key> [--url <base>] [--envs a,b,c] [--out dir]
Token: LD_TOKEN (falls back to LD_TOKEN_A) or --token.`);
  Deno.exit(0);
}
const cfg = await loadConfig(args.config);
const url = args.url ?? cfg.aUrl ?? HOSTS.us;
const project = args.project ?? cfg.aProject;
const token = args.token ?? cfg.tokenA ?? Deno.env.get("LD_TOKEN") ?? Deno.env.get("LD_TOKEN_A");
if (!project || !token) { console.error("Error: --project and a token are required"); Deno.exit(64); }
const envKeys = args.envs ? args.envs.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const client = makeClient({ baseUrl: url, token, log: (s) => stderr(`${s}\n`) });
const inv = await inventoryProject(client, project, { envKeys, onProgress: (l) => stderr(`\r${l.padEnd(60)}`) });
stderr("\n");
const md = inventoryToMarkdown(inv);
await writeOut(args.out, `inventory-${project}.json`, JSON.stringify(inv, null, 2));
const mdPath = await writeOut(args.out, `inventory-${project}.md`, md);
console.log(md);
console.log(`Written to ${mdPath}`);
