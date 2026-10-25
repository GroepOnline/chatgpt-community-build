#!/usr/bin/env bash
# Explicit future workstation promotion. Default is STAGE ONLY: never installs.
set -Eeuo pipefail
umask 077
REPO="GroepOnline/chatgpt-community-build"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODE="stage"
TAG=""
ROLLBACK_ARG=""
STATE=""
ARMED=0
ACCEPTED=0
STOPPED=0
TIMER_STOPPED=0
ROLLBACK=""
ARCH=""
OLD_VERSION=""

die() { printf 'BLOCK release_install: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'Usage: %s [--stage|--apply] [--tag community-vYYYY.MM.DD.RUN] [--rollback-deb PATH]\n' "$0"
  printf 'Default: --stage only. --apply may stop all official/Community ChatGPT and Codex processes.\n'
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) MODE=stage; shift ;;
    --apply) MODE=apply; shift ;;
    --tag) [[ $# -ge 2 ]] || die 'Missing --tag value'; TAG="$2"; shift 2 ;;
    --rollback-deb) [[ $# -ge 2 ]] || die 'Missing --rollback-deb path'; ROLLBACK_ARG="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unrecognized argument: $1" ;;
  esac
done
command -v gh >/dev/null || die 'GitHub CLI (gh) is required'
command -v node >/dev/null || die 'Node.js 22+ is required'
command -v dpkg-deb >/dev/null || die 'Debian dpkg-deb is required'
command -v sha256sum >/dev/null || die 'GNU sha256sum is required'
command -v timeout >/dev/null || die 'GNU timeout is required'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
  die 'Node.js 22+ required for WebSocket acceptance checks'
[[ "$(id -u)" -ne 0 ]] || die 'Run as logged-in desktop user, never sudo'
ARCH="$(dpkg --print-architecture)"
[[ "$ARCH" == amd64 || "$ARCH" == arm64 ]] || die 'Only amd64 and arm64 are supported'

if [[ -z "$TAG" ]]; then
  TAG="$(gh release list -R "$REPO" --limit 30 --json tagName,isPrerelease,isDraft \
    --jq '[.[] | select((.isDraft or .isPrerelease) and (.tagName | startswith("community-v")))] | .[0].tagName' || true)"
fi
[[ "$TAG" =~ ^community-v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] ||
  die 'No accessible Community draft/prerelease found, or invalid --tag'
VERSION="${TAG#community-v}"
ASSET="codex-desktop_${VERSION}_${ARCH}.deb"
STORE="$HOME/.local/share/chatgpt-community"
mkdir -p "$STORE/staged" "$STORE/receipts" "$STORE/backups"
chmod 700 "$STORE" "$STORE/staged" "$STORE/receipts" "$STORE/backups"
STAGE="$STORE/staged/$TAG/$ARCH"
if [[ -L "$STAGE" ]]; then die 'Refusing symlinked stage path'; fi
if [[ ! -d "$STAGE" ]]; then
  tmp="$(mktemp -d "$STORE/staged/.download.XXXXXXXX")"
  if ! gh release download "$TAG" -R "$REPO" -D "$tmp" \
      -p "$ASSET" -p "release-metadata.json" -p "SHA256SUMS"; then
    rm -rf -- "$tmp"
    die 'Download failed; no system changes'
  fi
  if ! node "$ROOT/scripts/assemble-release.mjs" --mode verify --stage-dir "$tmp" \
       --tag "$TAG" --arch "$ARCH"; then
    rm -rf -- "$tmp"
    die 'Downloaded asset failed provenance or SHA256 validation'
  fi
  mkdir -p "$STORE/staged/$TAG"
  mv -- "$tmp" "$STAGE"
fi
node "$ROOT/scripts/assemble-release.mjs" --mode verify \
  --stage-dir "$STAGE" --tag "$TAG" --arch "$ARCH" ||
  die 'Staged file verification failed'
DEB="$STAGE/$ASSET"
if [[ "$MODE" == stage ]]; then
  printf 'STAGED_ONLY %s\n' "$DEB"
  printf 'No package, profile, process, timer, or desktop state was changed.\n'
  exit 0
fi

# Applying is always explicit and happens ONLY on a connected local workstation.
OLD_VERSION="$(dpkg-query -W -f='${Version}' codex-desktop 2>/dev/null)" ||
  die 'No installed Community package to roll back to'
if [[ "$OLD_VERSION" == "$VERSION" ]]; then
  printf 'ALREADY_INSTALLED %s; no process was stopped\n' "$VERSION"
  exit 0
fi
command -v sudo >/dev/null || die 'sudo not available'
sudo -n true || die 'Authorize sudo first (sudo -v); refusing to stop an app without package permissions'
[[ "$(df -B1 --output=avail "$HOME" | tail -1)" -gt 8589934592 ]] ||
  die 'At least 8 GiB free space is required for rollback and profile snapshot'
runtime="/run/user/$(id -u)"
[[ -d "$runtime" ]] || die 'No graphical user runtime'
[[ "$(df -B1 --output=avail "$runtime" | tail -1)" -gt 536870912 ]] ||
  die 'XDG_RUNTIME_DIR must have at least 512 MiB free'
STATE="$(mktemp -d "$STORE/backups/.promotion.XXXXXXXX")"
chmod 700 "$STATE"

# Previous package is a hard prerequisite. No rollback receipt = no install.
if [[ -n "$ROLLBACK_ARG" ]]; then
  [[ -f "$ROLLBACK_ARG" && ! -L "$ROLLBACK_ARG" ]] || die 'Invalid --rollback-deb'
  cp -a -- "$ROLLBACK_ARG" "$STATE/rollback.deb"
else
  cached="$HOME/.cache/chatgpt-community-rollback-20261025/codex-desktop_${OLD_VERSION}_${ARCH}.deb"
  if [[ -f "$cached" && ! -L "$cached" ]]; then
    cp -a -- "$cached" "$STATE/rollback.deb"
  else
    command -v dpkg-repack >/dev/null || die 'Install dpkg-repack, or pass --rollback-deb, before upgrading'
    (cd "$STATE" && sudo -n dpkg-repack codex-desktop)
    repacked="$STATE/codex-desktop_${OLD_VERSION}_${ARCH}.deb"
    [[ -f "$repacked" ]] || die 'dpkg-repack did not produce the expected exact package'
    mv -- "$repacked" "$STATE/rollback.deb"
  fi
fi
ROLLBACK="$STATE/rollback.deb"
[[ "$(dpkg-deb -f "$ROLLBACK" Package)" == codex-desktop ]] ||
  die 'Rollback package identity invalid'
[[ "$(dpkg-deb -f "$ROLLBACK" Version)" == "$OLD_VERSION" ]] ||
  die 'Rollback version not equal to current installed version'
[[ "$(dpkg-deb -f "$ROLLBACK" Architecture)" == "$ARCH" ]] ||
  die 'Rollback architecture mismatch'
sha256sum "$ROLLBACK" > "$STATE/rollback.SHA256SUMS"
sha256sum "$DEB" > "$STATE/candidate.SHA256SUMS"

load_display() {
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]] && command -v systemctl >/dev/null; then
    while IFS='=' read -r key val; do
      case "$key" in
        DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)
          export "$key=$val" ;;
      esac
    done < <(systemctl --user show-environment 2>/dev/null || true)
  fi
  [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]] ||
    die 'No graphical login available for real chat acceptance'
}
start_community() {
  load_display
  local launcher="$HOME/.local/bin/codex-desktop"
  [[ -x "$launcher" ]] || launcher="/opt/codex-desktop/start.sh"
  [[ -x "$launcher" ]] || return 1
  nohup "$launcher" --disable-gpu --remote-debugging-port=9223 \
    >> "$STATE/launch.log" 2>&1 </dev/null &
}
boot_gate() {
  timeout 112s node "$ROOT/scripts/check-chat-boot.mjs" --port 9223 --timeout 90 &&
    sleep 5 &&
    timeout 20s node "$ROOT/scripts/check-chat-boot.mjs" --port 9223 --timeout 10
}
clean_up() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$ARMED" == 1 && "$ACCEPTED" != 1 ]]; then
    echo 'CANDIDATE_REJECTED: attempting tested rollback' >&2
    node "$ROOT/scripts/stop-chatgpt-desktop.mjs" --close
    if node "$ROOT/scripts/verify-desktop-quiescence.mjs"; then
      if sudo -n dpkg -i "$ROLLBACK"; then
        # Restore the quiescent pre-upgrade profile, without discarding rejected state.
        if [[ -d "$STATE/snapshot/Codex" ]]; then
          [[ ! -e "$STATE/rejected-Codex" ]] && mv "$HOME/.config/Codex" "$STATE/rejected-Codex"
          cp -a "$STATE/snapshot/Codex" "$HOME/.config/Codex"
        fi
        [[ -f "$STATE/snapshot/config.toml" ]] &&
          cp -a "$STATE/snapshot/config.toml" "$HOME/.codex/config.toml"
        [[ -f "$STATE/snapshot/auth.json" ]] &&
          cp -a "$STATE/snapshot/auth.json" "$HOME/.codex/auth.json"
        if start_community && boot_gate; then
          echo 'ROLLBACK_VERIFIED: previous package and profile recovered' >&2
        else
          echo 'ROLLBACK_INCOMPLETE: old package restored but chat boot gate failed' >&2
        fi
      else
        echo 'ROLLBACK_FAILED: restore previous DEB manually from private backup' >&2
      fi
    else
      echo 'ROLLBACK_BLOCKED: processes still active; previous DEB retained' >&2
    fi
  fi
  if [[ "$ARMED" != 1 && "$STOPPED" == 1 && "$ACCEPTED" != 1 ]]; then
    # A pre-dpkg refusal must not leave the working app unnecessarily closed.
    if node "$ROOT/scripts/verify-desktop-quiescence.mjs"; then
      if start_community && boot_gate; then
        echo 'OLD_SESSION_RESTARTED: package was never changed' >&2
      else
        echo 'OLD_SESSION_RESTART_FAILED: manual login may be needed' >&2
      fi
    else
      echo 'OLD_SESSION_RESTART_BLOCKED: active helpers remain' >&2
    fi
  fi
  if [[ "$TIMER_STOPPED" == 1 ]]; then
    systemctl --user start codex-memory-r2.timer || echo 'WARN: unable to resume memory timer' >&2
  fi
  exit "$status"
}
trap clean_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

load_display
if systemctl --user is-active --quiet codex-memory-r2.timer 2>/dev/null; then
  systemctl --user stop codex-memory-r2.timer
  TIMER_STOPPED=1
fi
STOPPED=1
node "$ROOT/scripts/stop-chatgpt-desktop.mjs" --close ||
  die 'ChatGPT/Codex processes failed to stop'
node "$ROOT/scripts/verify-desktop-quiescence.mjs" ||
  die 'Zero-process gate failed; no installation'
sleep 3
node "$ROOT/scripts/verify-desktop-quiescence.mjs" ||
  die 'A ChatGPT/Codex helper restarted; refusing installation'
mkdir -p "$STATE/snapshot"
chmod 700 "$STATE/snapshot"
[[ ! -e "$HOME/.config/Codex" ]] ||
  cp -a "$HOME/.config/Codex" "$STATE/snapshot/Codex"
for name in config.toml auth.json; do
  [[ ! -f "$HOME/.codex/$name" ]] ||
    cp -a "$HOME/.codex/$name" "$STATE/snapshot/$name"
done
node "$ROOT/scripts/verify-desktop-quiescence.mjs" ||
  die 'Background process restarted during snapshot; no package changed'
ARMED=1
sudo -n dpkg -i "$DEB"
[[ "$(dpkg-query -W -f='${Version}' codex-desktop)" == "$VERSION" ]] ||
  die 'Installed package version mismatch'
node "$ROOT/scripts/verify-desktop-quiescence.mjs" ||
  die 'Another desktop instance started during dpkg'
start_community || die 'Community launcher missing'
boot_gate || die 'Mounted chat-webview runtime acceptance failed'
[[ "$(dpkg-query -W -f='${Version}' codex-desktop)" == "$VERSION" ]] ||
  die 'Package version drifted after launch'
ACCEPTED=1
printf '{"status":"LIVE_ACCEPTED","tag":"%s","version":"%s","previous":"%s"}\n' \
  "$TAG" "$VERSION" "$OLD_VERSION" > "$STORE/receipts/$VERSION.json"
printf 'LIVE_ACCEPTED Community %s; backup: %s\n' "$VERSION" "$STATE"
