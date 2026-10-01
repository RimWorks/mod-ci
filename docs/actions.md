# Composite actions

Actions a job calls with `uses:`, for the steps that are the same in every repo.

## `dotnet-sonar`

Builds a mod and runs the tests. It reports coverage to SonarCloud and fails on analyzer findings.

It is an action rather than a reusable workflow because Pickle stages game assemblies from a
container and RimObs builds a dashboard, both in the same job as the build. You cannot inject steps
into a called workflow, but a composite action drops into the caller's job.

The caller does its own checkout, because Sonar needs the full history to scope new code:

```yaml
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: RimWorks/mod-ci/.github/actions/dotnet-sonar@v3
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

## `stage-game-refs`

Pulls a RimWorld game image and copies its managed assemblies onto the runner, with `Version.txt`
beside them. `dotnet-build` calls it once per matrix leg, so use it directly only in a job that
builds a mod outside that workflow.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/stage-game-refs@v3
        id: refs
        with:
          image: ${{ needs.image-16.outputs.image-ref }}
```

The calling job needs `packages: read` and a `GITHUB_TOKEN`. An action cannot grant either. Pass
`token` only when the default `github.token` cannot read the image.

`managed-dir` is the staged directory. Hand it to msbuild as `GameManagedDir` and to `writeStamp`
as `refsDir`. `Version.txt` sits in it rather than at the game root, which is the layout a local
`gamecrate` refs directory has, so one path means one thing in both places.

## `steam-login`

Installs SteamCMD and restores a logged-in `config.vdf`. It exports `STEAMCMD_PATH` and
`STEAM_CONFIG_VDF` to the job. `steam-republish` calls it, so use it directly only when a job runs
its own Steam step.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/steam-login@v3
        with:
          steam-username: ${{ secrets.STEAM_USERNAME }}
          steam-config-vdf-b64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
```

Pass `steam-username` to log in up front. A stale config then fails in this step instead of partway
through a publish.

`STEAM_CONFIG_VDF` is the path of the restored file, not its contents. `semantic-release-steam` opens
that path, so a job that sets the variable itself from a secret makes the upload fail.

The two names hold different shapes. `STEAM_CONFIG_VDF_B64` is base64 of `config.vdf` and is what the
repo secret stores, which is why the input is `steam-config-vdf-b64`. `STEAM_CONFIG_VDF` is a path,
and this action is what writes the file and exports it. gamecrate is the exception: it reads base64
out of `STEAM_CONFIG_VDF` itself, so `steam-game-image-action` is handed the secret as-is and one job
cannot share a single `STEAM_CONFIG_VDF` between gamecrate and a publish step.

## `steam-republish`

Pushes an already-built mod to its Steam Workshop item. Used by `weekly-verify`, where the run
verifies against the current RimWorld and republishes with no code changes.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/steam-republish@v3
        with:
          steam-username: ${{ secrets.STEAM_USERNAME }}
          steam-config-vdf-b64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
          verified-rimworld: ${{ env.RIMWORLD_REF }}
          verified-tests: ${{ env.TESTS_PASSED }}
```

The repo's `scripts/workshop-bump.mjs` reads `WORKSHOP_ID` and falls back to the id hard-coded in the
script, so `workshop-id` is only needed to point a run at a different item.

## `gate`

Fails unless every job result handed to it passed or was skipped. A ruleset then requires one
check name that never moves.

```yaml
  gate:
    name: ci gate
    if: always()
    needs: [prose, links, images, build, quickstart]
    runs-on: ubuntu-latest
    steps:
      - uses: RimWorks/mod-ci/.github/actions/gate@v3
        with:
          results: ${{ join(needs.*.result, ' ') }}
```

`if: always()` is required, or a failed dependency skips the gate and the check never reports.

Two things to get right in `needs`. List the jobs that produce the matrix legs, not only the jobs
that consume them: a job whose dependency failed reports `skipped`, so leaving out an image or
prepare job lets a real failure through as a pass. And list only jobs that are green on the default
branch, because the gate inherits every red job it covers and blocks every pull request until that
job is fixed.

A skipped result passes. A job that had nothing to do is not a failure, and a fork pull request
skips any job that needs a secret.

A failed `ci gate` is cached with the run that produced it. A pull request that ran before the job
existed keeps the result it had, and a rebase does not clear it. Re-run the failed jobs.

The `needs` context is valid in the caller's workflow and not inside this action's manifest. So
`${{ join(needs.*.result, ' ') }}` belongs in the caller, and writing it anywhere in the manifest,
including an input description, fails the whole action with `Unrecognized named-value: 'needs'`
before a step runs.

## `discord-release`

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

      - uses: RimWorks/mod-ci/.github/actions/discord-release@v3
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

## `stage-mods`

Stages the mod under test, the mods it depends on, and the `ModsConfig.xml` the game boots with.
Use it when a job launches the game itself. [Quickstarts][qs] runs a quickstart smoke test rather
than a Pickle suite, and needs the staging without the runner.

```yaml
      - uses: RimWorks/mod-ci/.github/actions/stage-mods@v3
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
