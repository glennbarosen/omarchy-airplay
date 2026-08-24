#!/bin/bash
#
# Re-pick what gets mirrored to one AirPlay receiver.
#
# WHY THIS EXISTS, AND WHAT IT TOUCHES
# ------------------------------------
# doubletake has no runtime command to change the capture source. The
# xdg-desktop-portal screencast session fixes it when a stream starts, and the
# `restore_token` doubletake saves in its credentials file makes every later
# connect silently reuse that same source — which is exactly what makes
# reconnecting prompt-free.
#
# So "share something else" means forgetting that one token and reconnecting.
# This script therefore writes to doubletake's own credentials file. It removes
# ONLY the `restore_token` key for the named receiver. The Ed25519 pairing
# material (pairing_id, ed25519_public, ed25519_seed) is left untouched, so this
# never costs you the pairing. The write is atomic (temp file + mv), the result
# is rejected unless it is a non-empty JSON object, and the target is refused if
# it is a symlink.
#
# It does not use sudo, touch anything outside the doubletake credentials file,
# or talk to the network. Set DOUBLETAKE_CREDS if your daemon runs with a
# non-default -creds path.
#
# Usage: reshare.sh <device-id> <ip> [hwaccel]

set -euo pipefail

fail() {
  printf '{"ok":false,"state":"idle","error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 1
}

device_id="${1:-}"
target="${2:-}"
hwaccel="${3:-auto}"

[[ $device_id =~ ^[A-Za-z0-9:._-]{1,64}$ ]] || fail "refusing to act on a malformed device id"
[[ $target =~ ^[A-Za-z0-9.:_-]{1,255}$ ]] || fail "refusing to act on a malformed target address"
case "$hwaccel" in
  auto | vaapi | nvenc | openh264 | none) ;;
  *) hwaccel=auto ;;
esac

creds="${DOUBLETAKE_CREDS:-$HOME/.config/doubletake/credentials.json}"
socket="${XDG_RUNTIME_DIR:-/tmp}/doubletake.sock"

doubletake-ctl disconnect >/dev/null 2>&1 || true

if [[ -e $creds ]]; then
  [[ -L $creds ]] && fail "credentials path is a symlink; refusing to write through it"
  [[ -f $creds ]] || fail "credentials path is not a regular file"

  tmp=$(mktemp "${creds}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  jq --arg id "$device_id" \
    'if has($id) then .[$id] |= del(.restore_token) else . end' "$creds" >"$tmp" \
    || fail "could not rewrite credentials"
  # Never install an empty or unparseable result over working credentials.
  jq -e 'type == "object" and length > 0' "$tmp" >/dev/null \
    || fail "refusing to write malformed credentials"
  chmod 600 "$tmp"
  mv "$tmp" "$creds"
  trap - EXIT
fi

# The daemon caches credentials for the life of the process, so only a restart
# makes it ask the portal again. Anchored and scoped to this user's own
# processes so nothing else on the system can match.
pkill -u "$(id -u)" -f '^doubletake -daemonize' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
  [[ -S $socket ]] || break
  sleep 0.1
done
rm -f "$socket"

setsid doubletake -daemonize -hwaccel "$hwaccel" >/dev/null 2>&1 </dev/null &

for _ in $(seq 1 60); do
  [[ -S $socket ]] && break
  sleep 0.1
done
[[ -S $socket ]] || fail "the AirPlay service did not restart"

exec doubletake-ctl connect "$target"
