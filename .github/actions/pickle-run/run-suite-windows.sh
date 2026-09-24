#!/usr/bin/env bash
# run-suite-windows.sh <image-ref> <mods-dir> <config-dir> <report-dir>
set -euo pipefail

IMAGE="${1:?usage: run-suite-windows.sh <image-ref> <mods-dir> <config-dir> <report-dir>}"
MODS_DIR="${2:?mods dir}"
CONFIG_DIR="${3:?config dir}"
REPORT_DIR="${4:?report dir}"

SUITE_FILTER="${SUITE_FILTER:-}"
UNFILTERED="${UNFILTERED:-false}"
SET_NAME="${SET_NAME:-}"
RUN_TIMEOUT="${RUN_TIMEOUT:-}"

TMP="${RUNNER_TEMP:-/tmp}"

# PickleArgs.IntArg silently keeps its own 60 for a value int.TryParse refuses
[[ -z "$RUN_TIMEOUT" || "$RUN_TIMEOUT" =~ ^[0-9]+$ ]] ||
  { echo "error: RUN_TIMEOUT is '$RUN_TIMEOUT', not a whole number" >&2; exit 1; }

# a mistyped mod directory reads as a missing def three minutes later, so name it now
for src in "$MODS_DIR" "$CONFIG_DIR"; do
  [[ -d "$src" ]] || { echo "error: no directory at $src" >&2; exit 1; }
done

if [[ -n "$SUITE_FILTER" ]]; then
  run_arg="-pickle-run=$SUITE_FILTER"
elif [[ "$UNFILTERED" == "true" ]]; then
  run_arg="-pickle-run"
else
  # an unfiltered run plays every other loaded mod's features, so the caller says so out loud
  echo "error: SUITE_FILTER is empty and UNFILTERED is not true" >&2
  exit 1
fi

echo "pulling $IMAGE ..."
docker pull -q "$IMAGE" || exit 1

mkdir -p "$REPORT_DIR"
chmod 777 "$REPORT_DIR"

echo "running: $run_arg"
# no ffmpeg and no published port in this container, so both stay off whatever the caller asked
game_args=("$run_arg" '-pickle-max-film-seconds=0')
if [[ -n "$SET_NAME" ]]; then
  game_args+=("-pickle-set-name=$SET_NAME")
fi
if [[ -n "$RUN_TIMEOUT" ]]; then
  game_args+=("-pickle-run-timeout=$RUN_TIMEOUT")
fi

: > "$TMP/container.log"
# GenFilePaths.ConfigFolderPath is savedatafolder plus Config, so one staged dir feeds both platforms
docker run --rm --name pickle-suite-win \
  -v "$MODS_DIR:/game/Mods:ro" \
  -v "$CONFIG_DIR:/config/Config" \
  -v "$REPORT_DIR:/out" \
  "$IMAGE" \
  run-headless-windows 'Z:\game\RimWorldWin64.exe' \
    '-savedatafolder=Z:\config' "${game_args[@]}" \
    '-pickle-report-dir=Z:\out' '-logfile' 'Z:\out\Player.log' \
  > "$TMP/container.log" 2>&1 &
game=$!

( until [[ -f "$REPORT_DIR/Player.log" ]]; do sleep 2; done
  exec tail -n +1 -f "$REPORT_DIR/Player.log" \
    > >(grep --line-buffered -oE 'pickle: .*') ) &
follow=$!

# the verdict step reads this code, so nothing may swallow it
status=0
wait "$game" || status=$?
sleep 1
kill "$follow" 2>/dev/null || true
exit "$status"
