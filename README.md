# @rimworks/mod-ci

Shared release plumbing for the RimWorks RimWorld mods: publish stamps, Steam Workshop bumps,
release-zip checks, Discord announcements, and the CI workflows that run them.

RimLogging, Pickle, Quickstarts and RimObs each kept near-identical copies of these scripts. The
copies drifted. A fix merged into one copy and the other three went stale.

Used by [RimLogging][rl], [Pickle][pk], [Quickstarts][qs] and [RimObs][ro].

## Install

```bash
npm install --save-dev github:RimWorks/mod-ci#v1
```

This package is not on npm. Consumers install from a git tag, so a release never has to push a
version commit back to a protected branch.

`bumpWorkshop` also needs `semantic-release-steam`. It is an optional peer dependency. Install it
only in repos that publish to the Steam Workshop.

## What's in here

| Kind | Name | Purpose |
|---|---|---|
| Module | `writeStamp` | Writes `About/PublishStamp.txt` with the versions the mod was built against |
| Module | `bumpWorkshop` | Stages the mod and pushes it to its Workshop item |
| Module | `packageMod` | Stages a mod the way Steam does and zips it |
| Module | `missingFromReleaseZip` | Finds mod folders the GitHub release zip drops |
| Module | `buildReleasePayload` | Builds the Discord embed for a published release |
| CLI | `package-mod` | Builds the release zip from `.steamignore` |
| CLI | `verify-ship-list` | Checks a repo's release zip includes every mod content directory |
| CLI | `discord-release` | Posts the release embed to a webhook |
| Workflow | `assetbundles` | Builds Unity asset bundles and uploads one zip per mod |
| Workflow | `codeql` | GitHub code scanning |
| Workflow | `dependabot-automerge` | Merges patch and minor dependency updates |
| Workflow | `dotnet-build` | Builds, tests, publishes results and checks formatting |
| Workflow | `game-image` | Builds a RimWorld image from Steam and returns its ref |
| Workflow | `links` | Checks markdown links with lychee |
| Workflow | `node-build` | Builds a Node subproject and uploads its output |
| Workflow | `pickle-suite` | Plays a Pickle suite against the game in a container |
| Workflow | `prose` | Runs Vale on documentation |
| Workflow | `ship-list` | Runs `verify-ship-list` against the caller |
| Workflow | `sonar` | SonarCloud scan for a .NET mod |
| Workflow | `sonar-scan` | SonarCloud scan for a repo with no .NET solution |
| Workflow | `test` | Installs Node and runs `npm test` |
| Action | `discord-release` | Announces a release in Discord |
| Action | `dotnet-sonar` | Build, analyzer gate, tests and coverage inside a Sonar scan |
| Action | `stage-mods` | Stages a mod, its dependencies and the `ModsConfig` the game boots with |
| Action | `steam-login` | Installs SteamCMD and restores a logged-in config |
| Action | `steam-republish` | Pushes an already-built mod to its Workshop item |

Pin workflows and actions to the major tag, `v1`. `semantic-release-github-actions-tags` moves
`v1` and the minor tag to each new release. A consumer picks up fixes without a bump. It never
picks up a breaking change.

Actions inside these workflows are pinned to their major tag too, not to a commit SHA. A SHA
never picks up a security fix on its own, and every consumer then waits on a release here.
Because of that, `codeql` excludes the `actions/unpinned-tag` query. Without the exclusion it
reports every workflow in every consumer.

## Modules

### `writeStamp`

Records what a verification run tested against. Pass the solution so the stamp can list resolved
package versions.

```js
import { writeStamp } from '@rimworks/mod-ci';

await writeStamp({ solution: 'RimWorks.RimLogging.sln' });
```

The stamp reads `VERIFIED_COMMIT` and `VERIFIED_TESTS` from the environment when they are set.
Omit `solution` and the stamp still writes, but without the package table.

### `packageMod`

```js
import { packageMod } from '@rimworks/mod-ci';

const { zipPath, entries } = await packageMod({ name: 'Pickle', version: '1.2.3' });
```

Returns the zip path and the top-level names that went in. Takes `modPath` for a repo that holds
several mods, and `outDir` when `dist` is taken.

### `bumpWorkshop`

Pushes the mod to Steam with a fresh stamp. Weekly verification runs call it.

```js
import { bumpWorkshop } from '@rimworks/mod-ci';

await bumpWorkshop({ workshopId: '3733484696', solution: 'RimWorks.RimLogging.sln' });
```

It needs `STEAMCMD_PATH`, `STEAM_USERNAME` and `STEAM_CONFIG_VDF`. It does not set the title, preview
image or visibility. The Workshop page keeps what it already has.

Builds are deterministic. An unchanged source tree rebuilds to the same bytes, and Steam moves the
"Updated" date only when the content manifest changes. The stamp is what makes the date move.

## CLI

### `package-mod`

Builds the GitHub release zip. Run it after the build, in `prepareCmd`:

```bash
npx package-mod Pickle ${nextRelease.version}
```

It writes `dist/Pickle-1.2.3.zip`, containing a `Pickle/` folder a player drops straight into
`RimWorld/Mods`. Point the `@semantic-release/github` asset at `dist/Pickle-*.zip`.

The file list comes from `.steamignore`, the same list SteamCMD uploads through. There is no second
allowlist to drift from the first, which is the failure `verify-ship-list` exists
to catch. `README.md` is the one exception, put back because Steam drops it in favour of the
Workshop description and the downloaded zip has to include it.

It exits `1` when the directory has no `.steamignore` or no `About/About.xml`.

### `verify-ship-list`

Steam and GitHub select different file sets:

| Channel | Mechanism | Failure mode |
|---|---|---|
| Steam | Copies the mod folder, `.steamignore` **excludes** | Publishes too much |
| GitHub | `cp -r <allowlist>` in `release.config.mjs` **includes** | Publishes too little, silently |

Add an asset folder and Steam picks it up. The GitHub zip drops it, and nothing reports an error.
RimLogging published eight releases without `Textures/` this way. The log viewer could not load
its own button art, and the failure only appeared in a downstream repo's test run.

Run it against a repo root:

```bash
npx verify-ship-list .
```

It exits `1` and names the folders when the `cp -r` step misses one that exists in the repo. A
`release.config.mjs` with no `cp -r ... dist/` step exits `0`, because there is no zip to check.

### `discord-release`

Posts the release embed to a webhook. The `discord-release` action wraps it, so call the CLI
directly only outside a release event.

```bash
DISCORD_WEBHOOK_URL=... MOD_NAME=Pickle WORKSHOP_ID=... npx discord-release
```

It reads `RELEASE_TAG`, `RELEASE_URL`, `RELEASE_NOTES`, `DISCORD_ROLE_IDS` and `EMBED_COLOR` from
the environment too. Set `RELEASE_NOTES_FILE` instead of `RELEASE_NOTES` when the changelog is long
or has backticks in it. It exits `1` when `DISCORD_WEBHOOK_URL` is missing.

## Reusable workflows

Call these from a consumer repo instead of copying them.

### `assetbundles`

Builds Unity asset bundles for every mod directory you name, then uploads one zip per mod. The
Unity install takes about fifteen minutes. The job caches the built bundles and skips the
install on a hit.

```yaml
  assetbundles:
    uses: RimWorks/mod-ci/.github/workflows/assetbundles.yml@v1
    with:
      mods: |
        CosmereCore
        CosmereRoshar
        CosmereScadrial
    secrets:
      UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
      UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
```

`mods` is the only required input. The defaults match the AssetBundleBuilder layout:

- an `.assetbundler.toml` per repo and per mod
- a `make build-assets-all-verbose` target
- an `AssetBundles` directory inside each mod

Override `build-command`, `bundles-directory` or `cache-key-files` for a different layout.

`cache-key-files` is the input to get right. It is a comma separated list of `hashFiles`
patterns, and anything that changes a bundle has to appear in it. A pattern that misses a source
file makes the job serve stale bundles.

The output `artifact` returns the artifact name. A later job can download it without
repeating the string.

### `codeql`

Runs GitHub code scanning. The caller defines the triggers and has to grant `security-events: write`,
because a called workflow cannot widen the caller's scopes.

```yaml
name: codeql
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '17 6 * * 1'

jobs:
  analyze:
    uses: RimWorks/mod-ci/.github/workflows/codeql.yml@v1
    permissions:
      contents: read
      security-events: write
    with:
      languages: '["csharp", "actions"]'
```

`languages` is a JSON array and defaults to `["actions"]`, which every repo here can run.

### `dependabot-automerge`

Merges patch and minor updates. Major updates wait for a human, because MSTest 3 to 4 and
TypeScript 5 to 7 both broke the build.

```yaml
name: dependabot-automerge
on: pull_request_target

jobs:
  automerge:
    uses: RimWorks/mod-ci/.github/workflows/dependabot-automerge.yml@v1
```

### `links`

Checks markdown links with lychee and fails on a dead one. Relative links break silently when a
folder is renamed.

```yaml
  links:
    uses: RimWorks/mod-ci/.github/workflows/links.yml@v1
    with:
      args: --config lychee.toml --no-progress README.md docs/
```

`args` defaults to checking `README.md`, so a repo with a `lychee.toml` does not need any inputs.

### `node-build`

Installs, optionally lints, builds, and uploads a Node subproject's output as an artifact. A mod
that embeds a bundled UI needs those files before the C# build runs, and more than one workflow in
the same repo usually needs them.

```yaml
  dashboard:
    uses: RimWorks/mod-ci/.github/workflows/node-build.yml@v1
    with:
      working-directory: Dashboard
      lint: true
      artifact-name: dashboard-dist
```

`artifact-path` defaults to `dist`, relative to `working-directory`.

### `pickle-suite`

Plays a Pickle suite against a live game. The job builds the mod and stages it alongside the mods
it depends on. It then runs the features in a container and reads pass or fail out of the report.
Pickle, Quickstarts and RimworldCosmere each kept a near-identical copy of that script set, and
the copies drifted apart. That is the failure the release plumbing here exists to stop.

```yaml
  suite:
    uses: RimWorks/mod-ci/.github/workflows/pickle-suite.yml@v1
    with:
      mod-name: RimLogging
      mod-package-id: rimworks.rimlogging
      game-branch: version-1.6.4871
    secrets:
      STEAM_USERNAME: ${{ secrets.STEAM_USERNAME }}
      STEAM_CONFIG_VDF_B64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
```

| Input | Type | Default | What it does |
|---|---|---|---|
| `mod-name` | string | required | Mod name from `About.xml`, spaces included. Names the repo-root mount and is the default filter |
| `mod-package-id` | string | required | Newline list of the caller's `packageId` values, written last in `ModsConfig.xml` |
| `mod-dirs` | string | `''` | Newline list of `checkout-path:MountName`. Empty mounts the repo root as `mod-name` |
| `game-image` | string | `''` | Image to pull and run. Empty builds one from `game-branch` |
| `game-branch` | string | `''` | Steam branch the image job downloads, such as `version-1.6.4871` |
| `game-version` | string | `'1.6'` | The `<version>` written into `ModsConfig.xml`. Not read from the image |
| `backends` | string | `'["harmony"]'` | JSON array of `harmony`, `concord` or `both`. One matrix leg per entry |
| `mod-sets` | string | `''` | JSON array of `{name, backend, extraMods}`. Replaces `backends`, and its legs report instead of gating |
| `staged-mods` | string | `''` | Comma separated `owner/repo:AssetPrefix:packageId` of extra mods to download |
| `pickle-version` | string | `''` | Pickle release to stage. Empty takes the latest, or pass a tag, `self` or `none` |
| `suite-filter` | string | `''` | Value for `-pickle-run`. Empty falls back to `mod-name`. A leg then runs its own features and nobody else's |
| `unfiltered` | boolean | `false` | Run every discovered feature with no filter. Only Pickle's own repo wants this |
| `build-command` | string | `dotnet build -c Release` | Builds the mod before staging |
| `build-artifacts` | string | `''` | Newline list of `name:path` artifacts to download before the build |
| `dotnet-version` | string | `10.0.x` | Passed to `setup-dotnet`. Empty skips it, for a build that does not use the SDK |
| `platform` | string | `'linux'` | `linux` or `windows`. Read the Windows rule below |
| `run-timeout` | number | `30` | Value for `-pickle-run-timeout`, minutes. Pickle's own watchdog |
| `timeout-minutes` | number | `70` | The job timeout, the backstop for a wedged watchdog |
| `retries` | number | `0` | Extra container attempts, for a dead X server only |
| `film-seconds` | number | `0` | Value for `-pickle-max-film-seconds`. `0` skips the ffmpeg download |
| `live-dashboard` | boolean | `false` | Exposes Pickle's dashboard over a tunnel while the suite runs |
| `publish-report` | boolean | `false` | Pushes `report.html` to docbin |

The one output, `report-artifact`, carries the artifact name back so a later job can download the
merged report without repeating the string. A matrix cannot report counts as outputs, because a
called workflow has one string slot per output name and every leg writes the same slot. The counts,
and the message from each failed scenario, go to the job summary instead.

**Secrets.** `DOCBIN_TOKEN` when `publish-report` is true. `STEAM_USERNAME` and
`STEAM_CONFIG_VDF_B64` when `game-image` is empty, because the workflow then builds the image
itself. `GITHUB_TOKEN` is not declared and does not need to be: a called workflow reads it without
a declaration.

A caller has to respect the rules below. The first is a limit the workflow cannot detect. Each of
the rest fails the job rather than warning, because a job skipped by an `if:` reports as skipped
and most branch protection reads a skipped required job as green.

**Call it once per workflow run.** The merge job uploads a fixed `merged-report` and downloads
every `pickle-report-*` artifact in the run, so a second call in the same workflow collides on the
first and silently folds the other call's legs into one merged report. To run one leg alongside a
matrix, a Windows job say, call the `pickle-run` action directly instead. It takes the same inputs,
reads `github.token` without being handed one, and skips the merge.

**Name the game image.** `game-image` and `game-branch` cannot both be empty. Set the first to an
image the job pulls, or the second to a Steam branch it builds one from. On Windows, `game-image`
is required: the image workflow here downloads the Linux depot and cannot produce a Windows ref.

**Windows cannot film or tunnel.** `platform: windows` refuses a non-zero `film-seconds` and
`live-dashboard: true`. That script publishes only the game's own ports, and the ffmpeg it would
mount is a Linux binary. An input it cannot honour fails the job rather than being dropped. It does
read `suite-filter`.

**Leave the job room for every attempt.** `(retries + 1) * run-timeout + 15 < timeout-minutes`,
where the 15 minutes is a fixed allowance for checkout, the build, the image pull and staging.
Raise `timeout-minutes`, or lower `run-timeout` or `retries`. When the watchdog trips first, Pickle
writes a final report and the artifact uploads. When the job timeout trips first, the container
dies mid-run and the report left on disk says `in-progress` with partial counts.

**Keep `mod-dirs` mount names clear of the staged mods.** A mount named the same as a staged
dependency's folder is replaced by that dependency, and the suite then passes against code the run
never built.

**Give every leg its own name.** A leg is named by its `backends` entry, or by the `name` of its
`mod-sets` object, and each one uploads an artifact under that name. An empty name, or two legs
sharing one, fails before the first container starts.

### `prose`

Runs Vale and reports findings on the pull request. Pass `extra-command` to run one more check
after it, such as a docs catalogue check.

```yaml
  prose:
    uses: RimWorks/mod-ci/.github/workflows/prose.yml@v1
```

### `ship-list`

Runs `verify-ship-list` against the caller's repo. It checks out mod-ci separately. The caller
does not need a dependency on this package.

```yaml
  ship-list:
    uses: RimWorks/mod-ci/.github/workflows/ship-list.yml@v1
```

`ref` selects the mod-ci commit the checker runs from.

### `sonar`

Runs the `dotnet-sonar` action as a whole job, for a mod whose build does not need extra steps. It
checks out with full history, can install Node or pnpm, and can run a `pre-scan-command` for a
frontend build that produces lcov. Use the action instead when your job has to stage
something first.

```yaml
  sonar:
    uses: RimWorks/mod-ci/.github/workflows/sonar.yml@v1
    with:
      solution: RimWorks.RimLogging.sln
      project-key: RimWorks_rimworld-logging-framework
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

The job skips itself for `dependabot[bot]`. A dependabot pull request does not get repository
secrets, and the scan cannot authenticate with an empty token.

**Pull requests from forks.** A `pull_request` run from a fork does not get secrets either. The
scan dies on an empty token. Trigger the caller on `pull_request_target` instead. The job then
runs with the base repo's secrets. Both `sonar` and `sonar-scan` check out the PR head and
pass the PR number, branch and base to the scanner themselves. You do not have to change anything
else in the caller. Be aware of what that means: the fork's code is built with `SONAR_TOKEN` in the
environment. Key the caller's `concurrency` group on `github.event.pull_request.number`, not
`github.ref`, which is the base branch under `pull_request_target`.

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

concurrency:
  group: sonar-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

### `sonar-scan`

Runs SonarCloud analysis on a repo with no .NET solution. This is for the JS and shell repos,
where a scanner run does not need a build.

```yaml
  scan:
    uses: RimWorks/mod-ci/.github/workflows/sonar-scan.yml@v1
    with:
      project-key: RimWorks_your-repo
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

**Check Automatic Analysis first.** SonarCloud refuses a CI analysis outright when autoscan is
enabled, with `You are running CI analysis while Automatic Analysis is enabled`. Read
`sonar.autoscan.enabled` for the project before wiring this up, and only add it where autoscan is
off. A project with autoscan off and no CI analysis does not report anything at all, which is how
several of these repos sat twelve days stale with a green badge.

### `test`

Installs Node 22 and runs `npm test`. It suits a plain Node repo with no build step.

```yaml
  test:
    uses: RimWorks/mod-ci/.github/workflows/test.yml@v1
```

## Composite actions

### `dotnet-sonar`

Builds a mod and runs the tests. It reports coverage to SonarCloud and fails on analyzer findings.

It is an action rather than a reusable workflow because Pickle stages game assemblies from a
container and RimObs builds a dashboard, both in the same job as the build. You cannot inject steps
into a called workflow, but a composite action drops into the caller's job.

The caller does its own checkout, because Sonar needs the full history to scope new code:

```yaml
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: RimWorks/mod-ci/.github/actions/dotnet-sonar@v1
        with:
          solution: Quickstarts.slnx
          project-key: RimWorks_Rimworld-Quickstarts
          sonar-token: ${{ secrets.SONAR_TOKEN }}
          coverage-exclusions: Source/Quickstarts/UI/**
```

Coverage comes from `coverlet.collector`, which records hits only for a modern assembly. A mod
targeting `net472` alone reports 0% and no error. Give the mod project `net472;net10.0` and point
the test project at the net10.0 build. `net472` stays the only build the game loads.

The analyzer gate runs `dotnet format analyzers --severity info`. MSTest and CA rules default to
info severity, which `dotnet build` never prints. Without the gate a human first sees them as a
SonarCloud issue days later. Pass `analyzer-severity: none` to skip it.

### `steam-login`

Installs SteamCMD and restores a logged-in `config.vdf`. It exports `STEAMCMD_PATH` and
`STEAM_CONFIG_VDF` to the job. `steam-republish` calls it, so use it directly only when a job runs
its own Steam step.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/steam-login@v1
        with:
          steam-username: ${{ secrets.STEAM_USERNAME }}
          steam-config-vdf-b64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
```

Pass `steam-username` to log in up front. A stale config then fails in this step instead of partway
through a publish.

### `steam-republish`

Pushes an already-built mod to its Steam Workshop item. Used by `weekly-verify`, where the run
verifies against the current RimWorld and republishes with no code changes.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/steam-republish@v1
        with:
          steam-username: ${{ secrets.STEAM_USERNAME }}
          steam-config-vdf-b64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
          verified-rimworld: ${{ env.RIMWORLD_REF }}
          verified-tests: ${{ env.TESTS_PASSED }}
```

The repo's `scripts/workshop-bump.mjs` reads `WORKSHOP_ID` and falls back to the id hard-coded in the
script, so `workshop-id` is only needed to point a run at a different item.

### `discord-release`

Announces the release semantic-release just cut in the Discord releases channel, and pings that
mod's notification role. Add it to the release job, after semantic-release runs.

Releases cut with `secrets.GITHUB_TOKEN` do not fire the `release` event, because GitHub refuses to
trigger a workflow from its own token. This runs in the same job instead of listening
for the event.

```yaml
      - name: Record the tag before releasing
        id: before
        run: echo "tag=$(git describe --tags --abbrev=0 2>/dev/null || true)" >> "$GITHUB_OUTPUT"

      - name: Run semantic-release
        run: ./node_modules/.bin/semantic-release

      - uses: RimWorks/mod-ci/.github/actions/discord-release@v1
        with:
          webhook-url: ${{ secrets.DISCORD_WEBHOOK_URL }}
          mod-name: Pickle
          role-ids: ${{ vars.DISCORD_ROLE_IDS }}
          workshop-id: '3791648678'
          previous-tag: ${{ steps.before.outputs.tag }}
```

`previous-tag` is how it knows whether a release happened. semantic-release only tags when it
releases. An unmoved tag means the step posts nothing and exits clean. The checkout needs
`fetch-depth: 0`, or `git describe` does not find any tags.

The notes come from the GitHub release, so the repo has to publish one. A repo that only tags fails
here on purpose, with a message telling you to add `@semantic-release/github`.

The embed links the Workshop page and the release, and its body is the release notes. Notes longer
than the Discord embed limit are cut on a line break and end with a link to the full changelog.
Leave `workshop-id` empty for a mod that is not on the Workshop, and leave `role-ids` empty to
announce without a ping.

Both list inputs take comma separated values, because one Cosmere release covers Core, Scadrial and
Roshar together. Pass `workshop-id` as `Core=123, Scadrial=456` to label each link, and `role-ids`
as a list when a release covers several notification roles. `allowed_mentions` lists only those
roles, so a changelog that says `@everyone` cannot ping the server.

### `stage-mods`

Stages the mod under test, the mods it depends on, and the `ModsConfig.xml` the game boots with.
Use it when a job launches the game itself. [Quickstarts][qs] runs a quickstart smoke test rather
than a Pickle suite, and needs the staging without the runner.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/stage-mods@v1
        with:
          mods-dir: ${{ runner.temp }}/mods
          config-dir: ${{ runner.temp }}/config
          mod-name: Quickstarts
          mod-package-id: rimworks.quickstarts
          pickle-version: none
```

`pickle-version: none` stages no Pickle at all. Leave it empty to take the latest release, pass a
release tag to pin one, or `self` when the checkout is Pickle. `mod-dirs` takes newline
`checkout-path:MountName` pairs for a repo with several mods in it, and `mod-name` is the mount name
when `mod-dirs` is empty. `backends` picks which patch backend gets staged.

## Development

```bash
npm test
```

Tests use the built-in Node test runner, so there is nothing else to install.

[rl]: https://github.com/RimWorks/rimworld-logging-framework
[pk]: https://github.com/RimWorks/Rimworld-Pickle
[qs]: https://github.com/RimWorks/Rimworld-Quickstarts
[ro]: https://github.com/RimWorks/rimworld-observability-collector
