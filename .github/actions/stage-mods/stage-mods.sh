#!/usr/bin/env bash
# stage-mods.sh <harmony|concord|both> <mods-dir> <config-dir>
# Downloads the mods a suite needs and writes the config the game boots with. Versions float,
# so an upstream break shows up on the next run rather than the next bump.
set -euo pipefail

BACKENDS="${1:?usage: stage-mods.sh <harmony|concord|both> <mods-dir> <config-dir>}"
MODS_DIR="${2:?mods dir}"
CONFIG_DIR="${3:?config dir}"

MOD_DIRS="${MOD_DIRS:-}"
MOD_NAME="${MOD_NAME:-}"
MOD_PACKAGE_ID="${MOD_PACKAGE_ID:?the packageId of the mod under test, one per line}"
GAME_VERSION="${GAME_VERSION:-1.6}"
STAGED_MODS="${STAGED_MODS:-}"
# 'self', empty to float to the latest release, a release tag, or 'none' to leave pickle out.
PICKLE_VERSION="${PICKLE_VERSION:-}"

PICKLE_REPO="RimWorks/Rimworld-Pickle"

die() {
  echo "error: $*" >&2
  exit 1
}


[[ "$BACKENDS" == "harmony" || "$BACKENDS" == "concord" || "$BACKENDS" == "both" ]] ||
  die "backend '$BACKENDS' is not harmony, concord or both"

if [[ -z "$MOD_DIRS" ]]; then
  [[ -n "$MOD_NAME" ]] ||
    die "MOD_DIRS is empty and MOD_NAME is unset, so nothing names the mount for the repo root"
  MOD_DIRS=".:$MOD_NAME"
fi

mod_srcs=()
mod_mounts=()
while read -r entry; do
  [[ -n "$entry" ]] || continue
  src="${entry%%:*}"
  mount="${entry#*:}"
  [[ "$entry" == *:* && -n "$src" && -n "$mount" ]] ||
    die "mod dir '$entry' is not checkout-path:MountName"
  [[ "$mount" != */* && "$mount" != "." && "$mount" != ".." ]] ||
    die "mount '$mount' is a path, not a folder name under Mods"
  # A mistyped path reads as a missing def three minutes later, so catch it here.
  [[ -d "$src" ]] || die "mod dir '$src', mounted as '$mount', does not exist"
  mod_srcs+=("$src")
  mod_mounts+=("$mount")
done <<< "$MOD_DIRS"

caller_ids=()
while read -r id; do
  [[ -n "$id" ]] || continue
  [[ "$id" != *[[:space:]]* ]] ||
    die "mod package id '$id' has whitespace in it, so it is a mod name rather than a packageId"
  caller_ids+=("$id")
done <<< "$MOD_PACKAGE_ID"

[[ ${#caller_ids[@]} -gt 0 ]] || die "MOD_PACKAGE_ID is empty, so nothing would load the caller's mod"

staged_repos=()
staged_prefixes=()
staged_ids=()
if [[ -n "$STAGED_MODS" ]]; then
  IFS=',' read -ra entries <<< "$STAGED_MODS"
  for entry in "${entries[@]}"; do
    IFS=':' read -r repo prefix package_id rest <<< "$entry"
    [[ -n "$repo" && -n "$prefix" && -n "$package_id" && -z "$rest" ]] ||
      die "staged mod '$entry' is not owner/repo:AssetPrefix:packageId"
    staged_repos+=("$repo")
    staged_prefixes+=("$prefix")
    staged_ids+=("$package_id")
  done
fi

# stage_release_zip rm -rf's its destination, so a mount sharing a name would be replaced by it
reserved_names=()
reserved_owners=()
reserve() {
  reserved_names+=("$1")
  reserved_owners+=("$2")
}

[[ "$BACKENDS" == "harmony" ]] || reserve Concord "the Concord patch backend"
[[ "$BACKENDS" == "concord" ]] || reserve Harmony "the Harmony patch backend"
reserve RimLogging "the RimLogging framework"
[[ "$PICKLE_VERSION" == "self" || "$PICKLE_VERSION" == "none" ]] ||
  reserve Pickle "Pickle (PICKLE_VERSION '${PICKLE_VERSION:-latest}')"

for i in "${!staged_repos[@]}"; do
  reserve "${staged_repos[$i]##*/}" "the staged mod '${staged_repos[$i]}'"
done

for i in "${!mod_mounts[@]}"; do
  for j in "${!reserved_names[@]}"; do
    [[ "${mod_mounts[$i]}" == "${reserved_names[$j]}" ]] || continue
    die "mod dir '${mod_srcs[$i]}:${mod_mounts[$i]}' mounts as '${mod_mounts[$i]}', but" \
        "${reserved_owners[$j]} is staged into that folder and would replace it"
  done
done

mkdir -p "$MODS_DIR" "$CONFIG_DIR"

for i in "${!mod_srcs[@]}"; do
  dest="$MODS_DIR/${mod_mounts[$i]}"
  rm -rf "$dest"
  mkdir -p "$dest"
  # the game loads from Assemblies, so build intermediates are weight with no reader
  tar -c -C "${mod_srcs[$i]}" --exclude=.git --exclude=node_modules --exclude=Source \
      --exclude=Dashboard --exclude=pickle-reports --exclude=artifacts --exclude=bin \
      --exclude=obj . | tar -x -C "$dest"
  echo "staged ${mod_srcs[$i]} as ${mod_mounts[$i]}"
done

https_only=(--proto '=https' --proto-redir '=https')

gh_api() {
  local url="$1"

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -sSfL "${https_only[@]}" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$url"
  else
    curl -sSfL "${https_only[@]}" "$url"
  fi
}

# ref is 'latest' or 'tags/<tag>', the two release endpoints GitHub exposes.
stage_release_zip() {
  local repo="$1" prefix="$2" dest="$3" ref="${4:-latest}" tmp json url inner bad
  tmp="$(mktemp -d)"

  json="$(gh_api "https://api.github.com/repos/${repo}/releases/${ref}")" ||
    die "could not read the ${ref} release of ${repo}." \
        "GitHub allows 60 anonymous calls an hour; set GITHUB_TOKEN to raise it."

  url="$(printf '%s' "$json" | ASSET_PREFIX="$prefix" python3 -c 'import json, os, sys
prefix = os.environ["ASSET_PREFIX"]
assets = json.load(sys.stdin).get("assets", [])
match = [a for a in assets if a["name"].startswith(prefix) and a["name"].endswith(".zip")]
if not match:
    sys.exit(1)
print(match[0]["browser_download_url"])')" ||
    die "the ${ref} release of ${repo} has no ${prefix}*.zip asset"

  curl -sSfL "${https_only[@]}" "$url" -o "$tmp/mod.zip" ||
    die "could not download the ${prefix}*.zip asset of ${repo}"

  # the only thing between a compromised release asset and the runner, and they survive a float
  bad="$(unzip -Z1 "$tmp/mod.zip" | grep -E '(^|/)\.\./|^/' || true)"
  [[ -z "$bad" ]] ||
    die "the ${repo} zip has a path traversal or absolute entry, refusing to extract"

  bad="$(unzip -Z "$tmp/mod.zip" | grep -E '^l' || true)"
  [[ -z "$bad" ]] || die "the ${repo} zip has a symlink entry, refusing to extract"

  unzip -qo "$tmp/mod.zip" -d "$tmp/x" || die "could not unpack the ${repo} zip"

  inner="$(dirname "$(dirname "$(find "$tmp/x" -mindepth 2 -maxdepth 3 -path '*/About/About.xml' -print -quit)")")"
  [[ -d "$inner" && "$inner" != "." ]] ||
    die "no About/About.xml inside the ${repo} zip, so its mod folder cannot be found"

  rm -rf "$dest"
  mv "$inner" "$dest"
  rm -rf "$tmp"
}

# Concord first: PatchBackends prefers it when both are loaded.
active=()
if [[ "$BACKENDS" == "concord" || "$BACKENDS" == "both" ]]; then
  stage_release_zip "ConcordLib/RimWorld" "Concord-" "$MODS_DIR/Concord"
  active+=(concordlib.concord)
fi

if [[ "$BACKENDS" == "harmony" || "$BACKENDS" == "both" ]]; then
  stage_release_zip "pardeike/HarmonyRimWorld" "HarmonyMod" "$MODS_DIR/Harmony"
  active+=(brrainz.harmony)
fi

stage_release_zip "RimWorks/rimworld-logging-framework" "RimLogging-" "$MODS_DIR/RimLogging"

active+=(
  ludeon.rimworld
  ludeon.rimworld.royalty
  ludeon.rimworld.ideology
  ludeon.rimworld.biotech
  ludeon.rimworld.anomaly
  ludeon.rimworld.odyssey
  rimworks.rimlogging
)

for i in "${!staged_repos[@]}"; do
  repo="${staged_repos[$i]}"
  stage_release_zip "$repo" "${staged_prefixes[$i]}" "$MODS_DIR/${repo##*/}"
  active+=("${staged_ids[$i]}")
done

# 'self' means the checkout is pickle. 'none' means no suite runs, so nothing loads it
if [[ "$PICKLE_VERSION" != "self" && "$PICKLE_VERSION" != "none" ]]; then
  pickle_ref="latest"
  [[ -z "$PICKLE_VERSION" ]] || pickle_ref="tags/$PICKLE_VERSION"
  stage_release_zip "$PICKLE_REPO" "Pickle-" "$MODS_DIR/Pickle" "$pickle_ref"
  active+=(rimworks.pickle)
fi

# The caller loads last, after everything it depends on.
active+=("${caller_ids[@]}")

cat > "$CONFIG_DIR/ModsConfig.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>${GAME_VERSION}</version>
  <activeMods>
$(printf '    <li>%s</li>\n' "${active[@]}")
  </activeMods>
  <knownExpansions>
    <li>ludeon.rimworld.royalty</li>
    <li>ludeon.rimworld.ideology</li>
    <li>ludeon.rimworld.biotech</li>
    <li>ludeon.rimworld.anomaly</li>
    <li>ludeon.rimworld.odyssey</li>
  </knownExpansions>
</ModsConfigData>
EOF

cat > "$CONFIG_DIR/Prefs.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<PrefsData>
  <screenWidth>1920</screenWidth>
  <screenHeight>1080</screenHeight>
  <fullscreen>False</fullscreen>
  <volumeGame>0</volumeGame>
  <volumeMusic>0</volumeMusic>
  <volumeAmbient>0</volumeAmbient>
  <devMode>True</devMode>
  <runInBackground>True</runInBackground>
  <resetModsConfigOnCrash>False</resetModsConfigOnCrash>
</PrefsData>
EOF

# The game writes here as another uid inside the container.
chmod -R 777 "$CONFIG_DIR"

echo "staged '$BACKENDS':"
find "$MODS_DIR" -name '*.dll' -o -name 'About.xml' | sort
