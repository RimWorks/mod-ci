# CLI

Commands the package installs. A `release.config.mjs` and a workflow step both run them through `npx`.

## `package-mod`

Builds the GitHub release zip. Run it after the build, in `prepareCmd`:

```bash
npx package-mod Pickle ${nextRelease.version}
```

It writes `dist/Pickle-1.2.3.zip`, containing a `Pickle/` folder a player drops straight into
`RimWorld/Mods`. Point the `@semantic-release/github` asset at `dist/Pickle-*.zip`.

The file list comes from `.steamignore`, the same list SteamCMD uploads through, so there is no
second allowlist to drift from the first. `README.md` is the one exception, put back because Steam
drops it in favour of the Workshop description and the downloaded zip has to include it.

It exits `1` when the directory has no `.steamignore` or no `About/About.xml`.

## `build-mod`

Builds once per version that `loadFolders.xml` declares, each against that version's own
assemblies. It runs the same commands `releaseConfig` assembles, so a weekly verification run and
a release build the same way.

```bash
npx build-mod Pickle.slnx --nologo
```

Extra arguments go to every `dotnet build`. Do not pass `-c`, the command already sets it.

## `write-stamp`

Writes `About/PublishStamp.txt` for the newest version the mod declares.

```bash
npx write-stamp Pickle.slnx
```

It finds the assemblies through `GAME_MANAGED_1_6`, which `stage-game-refs` exports, and falls
back to the local gamecrate cache.

## `workshop-bump`

Stages the mod and pushes it to its Workshop item, with a fresh stamp.

```bash
npx workshop-bump Pickle.slnx 3791648678
```

The id can come from `WORKSHOP_ID` instead. It needs `STEAMCMD_PATH`, `STEAM_USERNAME` and
`STEAM_CONFIG_VDF`, which the `steam-republish` action sets.

## `verify-ship-list`

`loadFolders.xml` decides which game version loads which folder. It is the only list of the
versions a mod claims, so it is the thing to check the build against:

| Direction | Failure mode |
|---|---|
| `<v1.5>` declared, no `1.5/` built | RimWorld falls back to the root, so the mod doesn't load its assemblies |
| `1.4/` on disk, no `<v1.4>` block | RimWorld never reads it, so the zip and Steam carry dead weight |

Run it against a repo root, after the build and before `package-mod`:

```bash
npx verify-ship-list .
```

It exits `1` and names the versions in either direction, and `2` when there is no
`loadFolders.xml` or the file declares no `<vX.Y>` block at all.

The version folders are build output. A fresh checkout fails every declared version, which keeps
a release that only built 1.6 from publishing as 1.5 and 1.6.

## `discord-release`

Posts the release embed to a webhook. The `discord-release` action wraps it, so call the CLI
directly only outside a release event.

```bash
DISCORD_WEBHOOK_URL=... MOD_NAME=Pickle WORKSHOP_ID=... npx discord-release
```

It reads `RELEASE_TAG`, `RELEASE_URL`, `RELEASE_NOTES`, `DISCORD_ROLE_IDS` and `EMBED_COLOR` from
the environment too. Set `RELEASE_NOTES_FILE` instead of `RELEASE_NOTES` when the changelog is long
or has backticks in it. It exits `1` when `DISCORD_WEBHOOK_URL` is missing.
