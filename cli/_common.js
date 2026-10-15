import { parseArgs } from "@std/cli/parse-args";

export async function loadConfig(path) {
  if (!path) return {};
  return JSON.parse(await Deno.readTextFile(path));
}

export function parse(opts) {
  return parseArgs(Deno.args, { alias: { h: "help" }, ...opts });
}

export function parseEnvMap(s) {
  if (!s) return null;
  return String(s).split(",").map((p) => p.trim()).filter(Boolean).map((pair) => {
    const [a, b] = pair.split(":").map((x) => x.trim());
    return { a, b: b ?? a };
  });
}

export function pick(args, cfg, key, envName) {
  return args[key] ?? cfg[key] ?? (envName ? Deno.env.get(envName) : undefined);
}

export async function writeOut(dir, name, content) {
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir.replace(/\/+$/, "")}/${name}`;
  await Deno.writeTextFile(path, content);
  return path;
}

export const stderr = (s) => Deno.stderr.writeSync(new TextEncoder().encode(s));

export function progressPrinter() {
  const state = {};
  let last = "";
  return (p) => {
    if (p.phase === "compare") { stderr(`\rcomparing...${" ".repeat(40)}\n`); return; }
    state[`${p.phase}:${p.side}`] = p.total ? `${p.fetched}/${p.total}` : String(p.fetched);
    const line = Object.entries(state).map(([k, v]) => `${k} ${v}`).join("  ");
    if (line !== last) { stderr(`\r${line.padEnd(100)}`); last = line; }
  };
}
