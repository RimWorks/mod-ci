#!/usr/bin/env bash
# expose-dashboard.sh [port]
set -euo pipefail

# a matrix gives every leg its own port, so the caller offsets from 27750 per leg
PORT="${1:-${DASHBOARD_PORT:-27750}}"
# four legs means four URLs in one log, so each one says which set it belongs to
LABEL="${SET_NAME:-dashboard}"
CLOUDFLARED="${RUNNER_TEMP:-/tmp}/cloudflared-${PORT}"
LOG="${RUNNER_TEMP:-/tmp}/cloudflared-${PORT}.log"

# the runner downloads and executes this, so it stays pinned
CLOUDFLARED_TAG=2026.9.1
CLOUDFLARED_SHA256=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc

if ! curl -sSfL --proto '=https' --proto-redir '=https' -o "$CLOUDFLARED" \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_TAG}/cloudflared-linux-amd64"; then
  echo "::warning title=Pickle dashboard (${LABEL})::could not download cloudflared"
  exit 1
fi

if ! printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$CLOUDFLARED" | sha256sum --check --status -; then
  echo "::warning title=Pickle dashboard (${LABEL})::cloudflared sha256 was" \
    "$(sha256sum < "$CLOUDFLARED" | cut -d' ' -f1), expected ${CLOUDFLARED_SHA256}"
  exit 1
fi
chmod +x "$CLOUDFLARED"

for _ in $(seq 1 90); do
  if curl -sS -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 2
done

"$CLOUDFLARED" tunnel --url "http://localhost:${PORT}" --no-autoupdate > "$LOG" 2>&1 &

for i in $(seq 1 90); do
  url="$(grep -ohE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)"
  if [[ -n "$url" ]]; then
    echo "::notice title=Pickle dashboard (${LABEL})::${url}"
    printf '\n========================================\n'
    printf '  DASHBOARD [%s]: %s\n' "$LABEL" "$url"
    printf '========================================\n\n'
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf -- '- **%s** live dashboard: %s\n' "$LABEL" "$url" >> "$GITHUB_STEP_SUMMARY"
    fi

    while sleep 45; do
      echo "--- dashboard [${LABEL}]: ${url}"
    done
  fi
  if (( i % 10 == 0 )); then
    echo "still waiting for the ${LABEL} tunnel (${i}0s) ..."
  fi
  sleep 2
done

echo "::warning title=Pickle dashboard (${LABEL})::tunnel never reported a URL; last log line:"
tail -2 "$LOG" 2>/dev/null || true
exit 1
