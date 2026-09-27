# Multi-version mods

One commit builds a mod for every game version it supports. RimWorld picks the folder, so one zip
carries them all.

## The layout

```
About/                    read before loadFolders, so it stays at the root
loadFolders.xml           tells the game which folders to load
Defs/  Languages/  Textures/
1.5/
  Assemblies/             build output
  Defs/                   optional, when 1.5 needs different defs
  Harmony/Assemblies/     loaded only when Harmony is active
  Concord/Assemblies/     loaded only when Concord is active
1.6/
  ...
```

Root content is shared across versions. A version folder overrides it or adds to it.

## Folder priority

`loadFolders.xml` lists folders per version:

```xml
<loadFolders>
  <v1.6>
    <li>/</li>
    <li>1.6</li>
    <li IfModActive="brrainz.harmony">1.6/Harmony</li>
    <li IfModActive="concordlib.concord">1.6/Concord</li>
  </v1.6>
</loadFolders>
```

`ModContentPack.InitLoadFolders` reads that list backwards, so **the last entry has the highest
priority**. `DirectXmlLoader.XmlAssetsInModFolder` then keys each file by its path relative to the
folder and keeps the first one it finds.

So:

1. List `/` first. It is then the lowest priority, so a version folder can override it.
2. An override replaces a whole file, not one def. The key is the file path. A file that only one
   folder has is added rather than replaced.

## The assemblies

There is no reference package. Every build compiles against the real game assemblies, pulled from
a game image that [`game-image`](workflows.md#game-image) builds from Steam.

`Krafs.Rimworld.Ref` used to fill that role. It lags each game release, and it has no 1.7 at all,
while Steam has carried 1.7 on a beta branch for months. A game image has whatever Steam has.

A fresh clone cannot compile without Steam credentials and an image. That is the trade.

## Sources of the version

These four have to agree on the version, and each reads it from somewhere:

| Thing | Where it gets the version |
| --- | --- |
| The version list | `loadFolders.xml`, read by `declaredVersions` |
| A build's assemblies | `GAME_MANAGED_1_6`, exported by `stage-game-refs` |
| The `RW_1_6` constant | `GameVersion`, set per build |
| The stamp's game build | `Version.txt`, which the game itself writes |

`stage-game-refs` reads `major.minor` out of the image's own `Version.txt` and exports the
matching variable. A caller never writes a version, so it cannot write the wrong one.

## What stops a wrong build from passing

A version compiled against another version's assemblies usually still compiles. It writes the
right folder and exits 0, so nothing looks wrong until a player loads it. These checks catch it:

- `buildVersions` throws when a multi-version build shares one `GameManagedDir`.
- `RequireGameRefs` in each repo's `Directory.Build.props` fails when `$(GameVersion)` has no
  staged assemblies, and prints the `gamecrate` command that stages them.
- `verify-ship-list` compares `loadFolders.xml` to the folders on disk, in both directions, before
  the zip is cut.

## Adding a version

1. Add a `<vX.Y>` block to `loadFolders.xml`, with `/` first.
2. Add the version to `<supportedVersions>` in `About/About.xml`.
3. Add the Steam branch to the `branches` list on the `game-image` call.
4. Build it. The compiler lists every break.
5. Fix each break with `#if RW_X_Y` at the call site. For anything larger, put one file per
   version behind a shared interface.
