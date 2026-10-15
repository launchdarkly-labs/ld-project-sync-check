# ld-project-sync-check

Compare two LaunchDarkly projects field by field and report whether they are in sync. Built for
instance migrations (for example US → EU) where the acceptance test is "the target project is an
exact copy of the source". Works as a static web page (GitHub Pages) and as a Deno CLI, sharing
one comparison library so both produce the same report.

- **Web page**: paste a read-only API token per instance, pick the environment pairs, run. Tokens
  stay in your browser (optionally in `sessionStorage` for the tab) and are only sent to
  LaunchDarkly. The page has no backend and no analytics. Content Security Policy restricts network
  access to `app.launchdarkly.com`, `app.eu.launchdarkly.com` and the client-side SDK hosts.
- **CLI**: same comparison, writes `report.json` and `report.md` (the sign-off artefact), exit code
  reflects the result. Also includes an inventory of resources the migration tool does not carry,
  and an SDK-payload comparison (`/sdk/latest-all`) per environment pair.

## What "identical" means

The comparator checks exactly the fields the [LD→LD migration tool](https://github.com/launchdarkly-labs/ld-migration-scripts)
writes, after normalizing away everything server-generated or instance-specific
(`_id`, `_links`, `version`, `salt`, `sel`, timestamps, `_site`, `_summary`, rule/clause ids).

| Scope | Compared (error unless noted) |
|---|---|
| Project | Flag keys (missing in B = error, only in B = info), segment keys per environment pair |
| Flag level | `kind`, `name`, `description`, `temporary`, `tags` (as a set), `variations` (ordered: value, name, description), `defaults`, `archived`, `deprecated`, `clientSideAvailability` (`includeInSnippet` folded in; `usingMobileKey` mismatch = warning), `customProperties`; warning: `deprecatedDate`, `variationJsonSchema`; info: maintainer email (only with `--compare-maintainers`), maintainer team, experiments, `goalIds`, `viewKeys`, migration-flag settings |
| Per environment | `on`, `offVariation`, `fallthrough` (variation or rollout), `rules` (ordered; clauses ordered; `ref` = warning), individual targets (`targets` + `contextTargets` merged into one set per context kind and variation), `prerequisites`, `trackEvents`, `trackEventsFallthrough` |
| Segments | `name`, `description`, `tags`, `included`/`excluded` + context lists (merged, as sets), rules (clauses, weight, bucketBy, rollout context kind), `unbounded`. Big-segment membership is not exposed via REST and is noted, not compared |

Status is **fail** on any error-severity finding or fetch error, **warn** on warnings only, **pass** otherwise.
Percentage rollouts are flagged with a note: the bucketing salt differs between instances, so
individual contexts may land in a different bucket even when the rollout is identical.

## CLI

Requires [Deno](https://deno.com) 2.x. Tokens come from environment variables; nothing is written to disk except reports.

```bash
export LD_TOKEN_A=api-...   # source (reader is enough)
export LD_TOKEN_B=api-...   # target (reader is enough)

deno task check \
  --a-url https://app.launchdarkly.com --b-url https://app.eu.launchdarkly.com \
  --a-project my-project \
  --env-map "development:development,staging:staging,production:production" \
  --include-archived
```

Options: `--b-project` (defaults to `--a-project`), `--a-label/--b-label`, `--compare-maintainers`,
`--strict-extra`, `--key-prefix`, `--out dir`, `--fail-on warn`, `--config file.json` (same options
in camelCase). Exit codes: `0` pass, `1` fail, `2` warnings only.

```bash
# What else lives in the source project that the migration does not carry?
LD_TOKEN=api-... deno task inventory --project my-project --envs development,staging,production

# What do the server-side SDKs actually receive from each side? (SDK keys resolved via the REST tokens)
deno task sdk-diff --a-project my-project --env-map production:production
```

## Web page

Served from the repository root (`index.html` + `web/` + `lib/`). Run locally with
`deno task serve` and open http://localhost:8000. The `pages.yml` workflow deploys the same files
to GitHub Pages on every push to `main`.

## Development

```bash
deno task test   # unit tests with fixtures
deno task lint
deno check lib/*.js cli/*.js web/*.js
```

Plain ES modules with JSDoc, no build step, no runtime dependencies in the browser; the CLI uses
`@std/cli` for argument parsing.

## Limitations

- Big segment membership, experiment results, audit history and context data are not compared.
- Approval settings, environment settings and SDK keys are instance-specific and out of scope.
- Rate-limit headers may not be readable from a browser; the client then backs off on a fixed schedule.

Apache-2.0.
