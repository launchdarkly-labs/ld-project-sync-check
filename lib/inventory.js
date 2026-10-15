// Inventory of a project's resources, focused on what an LD->LD migration does NOT carry,
// so the gaps can be listed for the customer before the run. Every probe is best-effort:
// an endpoint that 403s/404s on an instance is reported as "unavailable", never thrown.

import { normalizeFlag } from "./normalize_flag.js";

export async function inventoryProject(client, projectKey, { envKeys, flags, onProgress = () => {} } = {}) {
  const probe = async (label, fn) => {
    onProgress(label);
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: `HTTP ${err?.status ?? 0}: ${err?.message ?? err}` };
    }
  };
  const count = (p) => (p.ok ? (Array.isArray(p.value) ? p.value.length : p.value) : `unavailable (${p.error})`);

  const project = await probe("project", () => client.getProject(projectKey));
  const environments = await probe("environments", () => client.listEnvironments(projectKey));
  const envs = environments.ok ? environments.value : [];
  const selectedEnvs = envKeys ?? envs.map((e) => e.key);

  const liveFlags = flags
    ? { ok: true, value: flags }
    : await probe("flags", () => client.listFlags(projectKey, { envs: selectedEnvs }));
  const archivedFlags = await probe("archived flags", () => client.listFlags(projectKey, { envs: [], archived: true }));

  const segmentsByEnv = {};
  for (const env of selectedEnvs) {
    const p = await probe(`segments ${env}`, () => client.listSegments(projectKey, env));
    segmentsByEnv[env] = p.ok
      ? { total: p.value.length, bigSegments: p.value.filter((s) => s.unbounded).length }
      : { error: p.error };
  }

  const contextKinds = await probe("context kinds", () => client.listContextKinds(projectKey));
  const metrics = await probe("metrics", () => client.paginate(`metrics/${enc(projectKey)}?limit=50`));
  const experiments = {};
  for (const env of selectedEnvs) {
    const p = await probe(`experiments ${env}`, () => client.paginate(`projects/${enc(projectKey)}/environments/${enc(env)}/experiments?limit=50`));
    experiments[env] = count(p);
  }
  const releasePipelines = await probe("release pipelines", () => client.paginate(`projects/${enc(projectKey)}/release-pipelines?limit=50`));
  const views = await probe("views", () => client.paginate(`projects/${enc(projectKey)}/views?limit=50`));
  const teams = await probe("teams", () => client.paginate(`teams?limit=50`));
  const roles = await probe("custom roles", () => client.paginate(`roles?limit=50`));
  const webhooks = await probe("webhooks", () => client.paginate(`webhooks`));
  const integrations = await probe("integrations", () => client.get(`integrations`));
  const relay = await probe("relay proxy configs", () => client.paginate(`account/relay-auto-configs`));
  const members = await probe("members", () => client.paginate(`members?limit=50`));

  // Flag-derived facts (from full flag objects)
  const derived = { withPrerequisites: 0, withMaintainerTeam: 0, withExperiments: 0, withRollouts: 0, withIndividualTargets: 0, withRules: 0, kinds: {}, maintainers: new Set(), noMaintainer: 0 };
  if (liveFlags.ok) {
    for (const f of liveFlags.value) {
      const nf = normalizeFlag(f, selectedEnvs);
      derived.kinds[nf.flagLevel.kind] = (derived.kinds[nf.flagLevel.kind] ?? 0) + 1;
      if (nf.flagLevel.maintainerTeamKey) derived.withMaintainerTeam++;
      if (nf.flagLevel.experiments > 0) derived.withExperiments++;
      if (nf.flagLevel.maintainerEmail) derived.maintainers.add(nf.flagLevel.maintainerEmail);
      else derived.noMaintainer++;
      const envsN = Object.values(nf.environments).filter(Boolean);
      if (envsN.some((e) => e.prerequisites.length)) derived.withPrerequisites++;
      if (envsN.some((e) => e.fallthrough.rollout || e.rules.some((r) => r.rollout))) derived.withRollouts++;
      if (envsN.some((e) => e.targets.length)) derived.withIndividualTargets++;
      if (envsN.some((e) => e.rules.length)) derived.withRules++;
    }
  }

  const envSettings = envs
    .filter((e) => selectedEnvs.includes(e.key))
    .map((e) => ({
      key: e.key,
      name: e.name,
      color: e.color,
      defaultTtl: e.defaultTtl,
      secureMode: Boolean(e.secureMode),
      defaultTrackEvents: Boolean(e.defaultTrackEvents),
      requireComments: Boolean(e.requireComments),
      confirmChanges: Boolean(e.confirmChanges),
      critical: Boolean(e.critical),
      tags: e.tags ?? [],
      approvalsRequired: Boolean(e.approvalSettings?.required),
      approvalBypass: e.approvalSettings?.canReviewOwnRequest ?? null,
    }));

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: client.baseUrl,
    projectKey,
    project: project.ok
      ? { name: project.value.name, tags: project.value.tags ?? [], defaultClientSideAvailability: project.value.defaultClientSideAvailability ?? null }
      : { error: project.error },
    environments: { all: envs.map((e) => e.key), selected: selectedEnvs, settings: envSettings },
    flags: {
      live: count(liveFlags),
      archived: count(archivedFlags),
      ...derived,
      maintainers: derived.maintainers.size,
    },
    segmentsByEnv,
    contextKinds: contextKinds.ok ? (contextKinds.value.items ?? []).map((k) => k.key).filter((k) => k !== "user") : `unavailable (${contextKinds.error})`,
    notMigrated: {
      metrics: count(metrics),
      experiments,
      releasePipelines: count(releasePipelines),
      views: count(views),
      teams: count(teams),
      customRoles: count(roles),
      webhooks: count(webhooks),
      integrations: integrations.ok ? countIntegrations(integrations.value) : `unavailable (${integrations.error})`,
      relayProxyConfigs: count(relay),
    },
    members: members.ok
      ? { total: members.value.length, pendingInvite: members.value.filter((m) => m._pendingInvite).length }
      : `unavailable (${members.error})`,
  };
}

function countIntegrations(body) {
  // GET /api/v2/integrations returns one entry per integration *kind*, each with its own `items`
  // (the configured instances). Count configurations, not kinds.
  const kinds = Array.isArray(body?.items) ? body.items : Object.values(body?.items ?? {});
  let n = 0;
  for (const k of kinds) n += Array.isArray(k?.items) ? k.items.length : 0;
  return n;
}

export function inventoryToMarkdown(inv) {
  const L = [];
  L.push(`# Inventory: ${inv.projectKey} @ ${inv.baseUrl}`);
  L.push("");
  L.push(`Generated ${inv.generatedAt}.`);
  L.push("");
  L.push("## Project");
  L.push("");
  L.push(`- Name: ${inv.project.name ?? inv.project.error}`);
  L.push(`- Tags: ${(inv.project.tags ?? []).join(", ") || "none"}`);
  L.push(`- Default client-side availability: ${JSON.stringify(inv.project.defaultClientSideAvailability)}`);
  L.push(`- Context kinds (non-user): ${Array.isArray(inv.contextKinds) ? inv.contextKinds.join(", ") || "none" : inv.contextKinds}`);
  L.push("");
  L.push("## Environments");
  L.push("");
  L.push(`All: ${inv.environments.all.join(", ")}. Selected: ${inv.environments.selected.join(", ")}.`);
  L.push("");
  L.push("| Env | Name | TTL | Secure | Track events | Require comments | Confirm changes | Critical | Approvals | Tags |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const e of inv.environments.settings) {
    L.push(`| ${e.key} | ${e.name} | ${e.defaultTtl} | ${e.secureMode} | ${e.defaultTrackEvents} | ${e.requireComments} | ${e.confirmChanges} | ${e.critical} | ${e.approvalsRequired} | ${e.tags.join(", ")} |`);
  }
  L.push("");
  L.push("## Flags");
  L.push("");
  const f = inv.flags;
  L.push(`- Live: ${f.live}; archived: ${f.archived}`);
  L.push(`- Kinds: ${Object.entries(f.kinds).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push(`- With prerequisites: ${f.withPrerequisites}; with individual targets: ${f.withIndividualTargets}; with rules: ${f.withRules}; with percentage rollouts: ${f.withRollouts}`);
  L.push(`- Distinct maintainers: ${f.maintainers}; without maintainer: ${f.noMaintainer}; maintained by a team: ${f.withMaintainerTeam}`);
  L.push(`- With experiments attached: ${f.withExperiments}`);
  L.push("");
  L.push("## Segments");
  L.push("");
  for (const [env, s] of Object.entries(inv.segmentsByEnv)) {
    L.push(`- ${env}: ${s.error ? s.error : `${s.total} (big segments: ${s.bigSegments})`}`);
  }
  L.push("");
  L.push("## Not carried by the migration tool");
  L.push("");
  const nm = inv.notMigrated;
  L.push(`- Metrics: ${nm.metrics}`);
  L.push(`- Experiments: ${Object.entries(nm.experiments).map(([e, n]) => `${e} ${n}`).join(", ")}`);
  L.push(`- Release pipelines: ${nm.releasePipelines}`);
  L.push(`- Views: ${nm.views} (migrated by ld-migration-scripts ≥ PR #18)`);
  L.push(`- Teams: ${nm.teams}; custom roles: ${nm.customRoles}`);
  L.push(`- Webhooks: ${nm.webhooks}; integrations: ${nm.integrations}; Relay Proxy configs: ${nm.relayProxyConfigs}`);
  L.push("");
  L.push("## Members");
  L.push("");
  L.push(typeof inv.members === "string" ? `- ${inv.members}` : `- Total: ${inv.members.total}; pending invites: ${inv.members.pendingInvite}`);
  L.push("");
  return L.join("\n");
}

const enc = encodeURIComponent;
