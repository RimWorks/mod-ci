#!/usr/bin/env bash
# run-suite.sh <image-ref> <mods-dir> <config-dir> <report-dir>
set -euo pipefail

IMAGE="${1:?usage: run-suite.sh <image-ref> <mods-dir> <config-dir> <report-dir>}"
MODS_DIR="${2:?mods dir}"
CONFIG_DIR="${3:?config dir}"
REPORT_DIR="${4:?report dir}"

SUITE_FILTER="${SUITE_FILTER:-}"
UNFILTERED="${UNFILTERED:-false}"
FILM_SECONDS="${FILM_SECONDS:-0}"
LIVE_DASHBOARD="${LIVE_DASHBOARD:-false}"
DASHBOARD_PORT="${DASHBOARD_PORT:-27750}"
SET_NAME="${SET_NAME:-}"
RUN_TIMEOUT="${RUN_TIMEOUT:-}"

# the action ships its scripts beside this one, wherever the runner unpacked it
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="${RUNNER_TEMP:-/tmp}"
CFG="/home/app/.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Config"

# PickleArgs.IntArg silently keeps its own 60 for a value int.TryParse refuses
for var in FILM_SECONDS RUN_TIMEOUT; do
  [[ -z "${!var}" || "${!var}" =~ ^[0-9]+$ ]] ||
    { echo "error: $var is '${!var}', not a whole number" >&2; exit 1; }
done

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
start=$SECONDS
docker pull -q "$IMAGE" || exit 1
echo "pulled in $((SECONDS - start))s"

mkdir -p "$REPORT_DIR"
chmod 777 "$REPORT_DIR"

echo "running: $run_arg"
game_args=("$run_arg" "-pickle-max-film-seconds=$FILM_SECONDS")
if [[ -n "$SET_NAME" ]]; then
  game_args+=("-pickle-set-name=$SET_NAME")
fi
if [[ -n "$RUN_TIMEOUT" ]]; then
  game_args+=("-pickle-run-timeout=$RUN_TIMEOUT")
fi

mounts=()
if [[ "$FILM_SECONDS" != "0" ]]; then
  if "$HERE/fetch-ffmpeg.sh" "$TMP/ffmpeg"; then
    mounts+=(-v "$TMP/ffmpeg:/usr/local/bin/ffmpeg:ro")
  else
    echo "::warning title=Pickle film::no ffmpeg, so this run keeps frames and gets no videos"
  fi
fi

ports=()
if [[ "$LIVE_DASHBOARD" == "true" ]]; then
  ports=(-p "$DASHBOARD_PORT:$DASHBOARD_PORT")
  game_args+=("-pickle-http-port=$DASHBOARD_PORT")
fi

: > "$TMP/container.log"
docker run --rm --name "pickle-suite${SET_NAME:+-$SET_NAME}" \
  -v "$MODS_DIR:/game/Mods:ro" \
  -v "$CONFIG_DIR:$CFG" \
  -v "$REPORT_DIR:/out" \
  "${ports[@]}" "${mounts[@]}" \
  "$IMAGE" \
  run-headless /game/RimWorldLinux "${game_args[@]}" \
    -pickle-report-dir=/out -logfile /out/Player.log \
  > "$TMP/container.log" 2>&1 &
game=$!
echo "game container started, waiting for its log ..."

# process substitution, not a pipe: $! after `tail | sed` is sed's, and the follower survives the kill
tail -n +1 -f "$TMP/container.log" > >(sed 's/^/[container] /') &
container_follow=$!

( sleep 45
  if [[ ! -f "$REPORT_DIR/Player.log" ]]; then
    echo "no Player.log after 45s; dumping state"
    docker ps -a --filter name=pickle-suite --format '{{.Status}} {{.Image}}'
    ls -la "$REPORT_DIR" || true
  fi ) &
watchdog=$!

( until [[ -f "$REPORT_DIR/Player.log" ]]; do sleep 1; done
  exec tail -n +1 -f "$REPORT_DIR/Player.log" \
    > >(grep --line-buffered -oE 'pickle: .*') ) &
follow=$!

helpers=("$follow" "$container_follow" "$watchdog")
if [[ "$LIVE_DASHBOARD" == "true" ]]; then
  "$HERE/expose-dashboard.sh" "$DASHBOARD_PORT" &
  helpers+=("$!")
fi

# the verdict step reads this code, so nothing may swallow it
status=0
wait "$game" || status=$?
sleep 1
kill "${helpers[@]}" 2>/dev/null || true
exit "$status"
