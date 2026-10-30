# ld-project-sync-check

Compare two LaunchDarkly projects field by field and report whether they are in sync. Built for
instance migrations (for example US → EU) where the acceptance test is "the target project is an
exact copy of the source". Works as a static web page (GitHub Pages) and as a Deno CLI, sharing
one comparison library so both produce the same report.

- **Web page**: paste a read-only API token per instance, pick the environment pairs, run. Tokens
  stay in your browser (optionally in `sessionStorage` for the tab) and are only sent to
  LaunchDarkly. The page has no backend and no analytics. Content Security Policy restricts network
  access to its own origin, `app.launchdarkly.com`, `app.eu.launchdarkly.com` and the client-side SDK hosts.
  A *drift check* view for the customer and a *migration operator* view that reads the migration's
  manifest and run record (see [Web page](#web-page)).
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
| Flag level | `kind`, `name`, `description`, `temporary`, `tags` (as a set), `variations` (ordered: value, name, description), `defaults`, `archived`, `deprecated`, `clientSideAvailability` (`includeInSnippet` folded in; `usingMobileKey` mismatch = warning), `customProperties`; warning: `variationJsonSchema`; info: `deprecatedDate` (stamped by the API, always differs), maintainer email (only with `--compare-maintainers`), maintainer team, experiments, `goalIds`, `viewKeys`, migration-flag settings |
| Per environment | `on`, `offVariation`, `fallthrough` (variation or rollout), `rules` (ordered; clauses ordered; `ref` = warning), individual targets (`targets` + `contextTargets` merged into one set per context kind and variation), `prerequisites`, `trackEvents`, `trackEventsFallthrough` |
| Segments | `name`, `description`, `tags`, `included`/`excluded` + context lists (merged, as sets), rules (clauses, weight, bucketBy, rollout context kind), `unbounded`. Big-segment membership is not exposed via REST and is noted, not compared |

**Rules that reference segments deleted from A.** LaunchDarkly keeps such rules in the source but
refuses to save them in the target (`unknown segment`), so the migration cannot recreate them. A
rule with a non-negated `segmentMatch` clause that lists only missing segments can never match, so
when B lacks it the checker reports it as an **info** finding ("dead rule skipped") with an
explanation instead of a rules mismatch. Rules that are still live — a negated clause on a missing
segment (matches every context) or a missing segment OR'd with an existing one — stay errors, with
a note explaining why B cannot reproduce them.

Status is **fail** on any error-severity finding or fetch error, **warn** on warnings only, **pass** otherwise.

Each flag result also carries source-side context that is reported, not compared: `createdA`
(the flag's `creationDate` in A) and `updatedA` (the latest `lastModified` among the compared A
environments; the flag API has no flag-level "last modified", so flag-level edits such as a new
description do not move it). A flag that is missing in B but was created a few minutes ago is
usually just newer than the migration run.
Percentage rollouts are flagged with a note: the bucketing salt differs between instances, so
individual contexts may land in a different bucket even when the rollout is identical.

## Sync state (with the migration's manifest)

During a migration the projects keep changing: the source until it is frozen, the target once teams
start working there. Given the sync manifest of [ld-migration-scripts](https://github.com/launchdarkly-labs/ld-migration-scripts)
(`data/launchdarkly-migrations/sync-manifest-<source>-<dest>.json`), and optionally the run record of
its last run (`runs/<source>/<dest>/latest.json`, ld-migration-scripts ≥ 3.6.0), the checker labels
every difference with why it exists:

| State | Meaning | Severity |
|---|---|---|
| `pendingSource` | Changed in A after the last sync (or created since); the next sync applies it | info |
| `editedInTarget` | Changed or deleted in B after the last sync. The migration never overwrites such edits, so it stays different by design | info |
| `conflict` | Changed on both sides; the source change will not be applied, resolve it in B if needed | warning |
| `cutOver` | The environment pair is no longer in the last run's environment mapping (it was cut over) | info |
| `untracked` | Not in the manifest (never migrated) | unchanged |
| `inSync` | Neither side changed since the last sync: the difference is unexplained | unchanged |

So after a cutover, **pass** means "nothing unexpected", not "identical". Flags and segments are
paired by the destination keys the manifest records (conflict-prefixed copies included, whose
prefixed name is expected), so
`--key-prefix` is not needed. The report gains a `sync` block (last sync, last run, counts per
state, cut-over environments, warnings) and a `sync` state on each flag and segment result; the
Markdown report a "Sync state" section.

The comparison is by version: a B version change counts as `editedInTarget` even if it changed
nothing the migration writes, while the migration itself protects only real content edits.
Manifests written before ld-migration-scripts 3.6.0 have no record of the destination state; then a
B environment or segment counts as edited when it was modified after the last sync.

```bash
deno task check --a-project my-project \
  --manifest ../ld-migration-scripts/data/launchdarkly-migrations/sync-manifest-my-project-my-project.json \
  --run-record ../ld-migration-scripts/data/launchdarkly-migrations/runs/my-project/my-project/latest.json
```

With `--run-record` and no `--env-map`, the run's environment mapping is used. In a `--config` file
the keys are `manifest` and `runRecord`. The CLI refuses a manifest written for other projects,
another destination instance or (when the manifest records it) another destination account (its
versions say nothing about this check), and ignores a run record
that belongs to a different manifest. A dry run's record (or one whose run did not write the
manifest) is shown, but its environment mapping is not used. Entries whose last sync failed have no
baseline and keep their findings. A recorded flag or segment deleted in B while A changed since
is a `conflict`.

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
`--strict-extra`, `--key-prefix`, `--manifest`, `--run-record` (see [Sync state](#sync-state-with-the-migrations-manifest)),
`--out dir`, `--fail-on warn`, `--config file.json` (same options in camelCase). Exit codes: `0`
pass, `1` fail, `2` warnings only.

```bash
# What else lives in the source project that the migration does not carry?
LD_TOKEN=api-... deno task inventory --project my-project --envs development,staging,production

# What do the server-side SDKs actually receive from each side? (SDK keys resolved via the REST tokens)
deno task sdk-diff --a-project my-project --env-map production:production
```

## Web page

**Two views**, switched in the header (the choice is remembered; `?view=drift` or `?view=operator`
in the URL picks one for that visit):

- **Drift check**, for anyone checking the target project, such as the customer. It opens with a
  plain-language verdict and the differences grouped by what they mean: *different and unexpected*,
  *changed on both sides*, *changed in B after the migration (protected)*, *waiting for the next
  sync*, *no longer synced* (cut over), *only in B* and *minor differences*. Without the
  migration's state every difference is unexpected; a report shared by the operator (see below)
  carries it. Key prefix and "flags only in B as errors" are not offered.
- **Migration operator** has everything in the drift check, plus a *Migration state* step: pick the
  sync manifest and, optionally, the run record of the last run (or of a dry run), as with the
  CLI's `--manifest` and `--run-record`. The files are read in the browser, never uploaded. The
  manifest fills in empty project keys; a run record from a run that wrote the manifest replaces the
  environment mapping with the run's. Results then add a last-sync line ("Last sync … · 326 flags
  tracked · 3.6.1 · dry-run … · 15 protected"), the manifest warnings, what the run left as it is
  in B (for a dry run: what a real run would leave), a *Sync* column on flags and segments and a
  *Sync* filter.

**Sharing a report.** *Download JSON* in the operator view, then *Open a shared report…* in any
view (on the hosted page, for example) shows that report with its sync states, with no tokens and
no manifest. The file is checked before it is shown, and its status is recomputed from its findings.

**Where it runs.** On GitHub Pages (`*.github.io`) the page opens as the drift check and shows a
notice about tokens. Served locally (`deno task serve`) it opens as the operator view. A local
console of ld-migration-scripts (planned) will answer `GET api/console`; the page asks for it
when it is not on GitHub Pages, so a 404 for `api/console` in the browser console is expected.

Results show flags by lifecycle state: **Active** (default; deprecated flags included and marked),
**Deprecated**, **Archived** and **All** (archived flags grouped at the end). Archived flags are
fetched by default in the web page. Created / updated (A) columns are sortable, and each row links
to the flag in A and B. The Markdown report lists the same timestamps (UTC) for missing and
differing flags.

Branding follows the `launchdarkly-brand-style` skill (2026 tokens in `web/brand/colors.css`, logo
lock-ups in `web/brand/`). Fonts use the brand stacks (Sora, Inter) only when installed locally, so
the page keeps talking to LaunchDarkly hosts only.

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
