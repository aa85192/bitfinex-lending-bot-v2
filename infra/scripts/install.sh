#!/usr/bin/env bash
# install.sh - Bitfinex Lending Bot installer for Debian-based GCP e2-micro VM.
#
# Usage (on the VM, as a user with sudo):
#   curl -fsSL https://raw.githubusercontent.com/aa85192/bitfinex-lending-bot-v2/claude/gcloud-realtime-monitoring-eval-EW1aX/infra/scripts/install.sh | sudo bash
#
# Environment overrides (all optional):
#   REPO_URL    git URL                   (default: https://github.com/aa85192/bitfinex-lending-bot-v2.git)
#   BRANCH      branch to deploy           (default: master)
#   INSTALL_DIR install path              (default: /opt/bitfinex-lending-bot)
#   BOT_USER    system user               (default: lendingbot)
#   GCP_PROJECT GCP project (Secret Manager) (auto-detected from metadata)
#   USE_SECRETS 1=fetch from Secret Manager (default 1 when gcloud present)
#
# Required Secret Manager secrets (when USE_SECRETS=1):
#   bitfinex-api-key, bitfinex-api-secret
# Optional:
#   bitfinex-aff-code, viewer-token
#
# Installation is idempotent; rerunning updates the install.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/aa85192/bitfinex-lending-bot-v2.git}"
BRANCH="${BRANCH:-claude/gcloud-realtime-monitoring-eval-EW1aX}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bitfinex-lending-bot}"
BOT_USER="${BOT_USER:-lendingbot}"
USE_SECRETS_DEFAULT="$(command -v gcloud >/dev/null 2>&1 && echo 1 || echo 0)"
USE_SECRETS="${USE_SECRETS:-$USE_SECRETS_DEFAULT}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  err "must run as root (try: sudo bash install.sh)"
  exit 1
fi

# ─── 1. system deps ──────────────────────────────────────────────────
log "installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades

# Node.js 20.x
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20\.'; then
  log "installing Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

# Caddy
if ! command -v caddy >/dev/null 2>&1; then
  log "installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y --no-install-recommends caddy
fi

# Google Cloud SDK (for Secret Manager); only if missing and we have access.
if ! command -v gcloud >/dev/null 2>&1; then
  log "installing google-cloud-cli (for Secret Manager)"
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -y
  apt-get install -y --no-install-recommends google-cloud-cli || warn "gcloud install failed; skipping Secret Manager"
fi

# ─── 2. system user ──────────────────────────────────────────────────
if ! id "$BOT_USER" >/dev/null 2>&1; then
  log "creating user $BOT_USER"
  useradd -r -m -d "/home/$BOT_USER" -s /bin/bash "$BOT_USER"
fi

# ─── 3. clone / update repo ──────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
chown "$BOT_USER:$BOT_USER" "$INSTALL_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "updating repo at $INSTALL_DIR"
  sudo -u "$BOT_USER" git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  sudo -u "$BOT_USER" git -C "$INSTALL_DIR" checkout "$BRANCH"
  sudo -u "$BOT_USER" git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  log "cloning $REPO_URL ($BRANCH)"
  sudo -u "$BOT_USER" git clone -b "$BRANCH" --depth 50 "$REPO_URL" "$INSTALL_DIR"
fi

# ─── 4. install npm deps ─────────────────────────────────────────────
log "installing npm dependencies (production)"
cd "$INSTALL_DIR"
sudo -u "$BOT_USER" npm install --omit=dev --no-audit --no-fund

# tsx is in devDependencies; we need it at runtime to execute TS sources.
sudo -u "$BOT_USER" npm install --no-save tsx@^4 --no-audit --no-fund

# ─── 5. resolve secrets ──────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
DATA_DIR="$INSTALL_DIR/data"
mkdir -p "$DATA_DIR"
chown "$BOT_USER:$BOT_USER" "$DATA_DIR"

get_secret() {
  local name="$1"
  local fallback="${2:-}"
  if [[ "$USE_SECRETS" == "1" ]] && command -v gcloud >/dev/null 2>&1; then
    local val
    val="$(gcloud secrets versions access latest --secret="$name" 2>/dev/null || true)"
    [[ -n "$val" ]] && { printf '%s' "$val"; return; }
  fi
  printf '%s' "$fallback"
}

BITFINEX_API_KEY="$(get_secret bitfinex-api-key)"
BITFINEX_API_SECRET="$(get_secret bitfinex-api-secret)"
BITFINEX_AFF_CODE="$(get_secret bitfinex-aff-code "")"
VIEWER_TOKEN_FROM_SM="$(get_secret viewer-token "")"

if [[ -z "$BITFINEX_API_KEY" || -z "$BITFINEX_API_SECRET" ]]; then
  warn "Bitfinex secrets not found in Secret Manager."
  if [[ -f "$ENV_FILE" ]]; then
    warn "Keeping existing $ENV_FILE (will not overwrite credentials)."
  else
    err "Create Secret Manager secrets 'bitfinex-api-key' and 'bitfinex-api-secret', or"
    err "manually edit $ENV_FILE after this script finishes."
  fi
fi

# ─── 6. generate VAPID keys (one-time, persisted in .env) ────────────
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""
if [[ -f "$ENV_FILE" ]]; then
  set +e
  VAPID_PUBLIC_KEY="$(grep -E '^VAPID_PUBLIC_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  VAPID_PRIVATE_KEY="$(grep -E '^VAPID_PRIVATE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  set -e
fi

if [[ -z "$VAPID_PUBLIC_KEY" || -z "$VAPID_PRIVATE_KEY" ]]; then
  log "generating VAPID keys"
  KEY_JSON="$(sudo -u "$BOT_USER" node -e \
    'const w = require("web-push"); console.log(JSON.stringify(w.generateVAPIDKeys()))' \
    --prefix "$INSTALL_DIR" 2>/dev/null || true)"
  if [[ -z "$KEY_JSON" ]]; then
    # node -e doesn't take --prefix; fall back without it
    KEY_JSON="$(cd "$INSTALL_DIR" && sudo -u "$BOT_USER" node -e \
      'const w = require("web-push"); console.log(JSON.stringify(w.generateVAPIDKeys()))')"
  fi
  VAPID_PUBLIC_KEY="$(printf '%s' "$KEY_JSON" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
  VAPID_PRIVATE_KEY="$(printf '%s' "$KEY_JSON" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')"
fi

# ─── 7. detect external IP for sslip.io ──────────────────────────────
EXT_IP="$(curl -fsSL -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)"
if [[ -z "$EXT_IP" ]]; then
  EXT_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -z "$EXT_IP" ]]; then
  err "could not detect external IP; set DOMAIN= manually in Caddyfile"
  EXT_IP="0.0.0.0"
fi
SLIPIO_DOMAIN="${EXT_IP//./-}.sslip.io"

VIEWER_TOKEN="${VIEWER_TOKEN_FROM_SM:-$(openssl rand -hex 16)}"

# strategy config file (optional, default empty)
STRATEGY_CONFIG_FILE_DEFAULT="${INSTALL_DIR}/strategy.yaml"
if [[ ! -f "$STRATEGY_CONFIG_FILE_DEFAULT" ]]; then
  install -o "$BOT_USER" -g "$BOT_USER" -m 600 /dev/stdin "$STRATEGY_CONFIG_FILE_DEFAULT" <<'YAML_EOF'
# Reactive-trading strategy config. Same shape as INPUT_AUTO_RENEW_3 in the
# GitHub Actions workflow. Each currency block tells the daemon how to size,
# rank-percentile, and pick the period for funding orders.
#
# This file is loaded ONLY when STRATEGY_MODE != off in .env.
#
# To enable:
#   1. Edit this file to set your currencies + params
#   2. Edit .env: STRATEGY_MODE=dry_run  (or =live once you trust it)
#   3. sudo systemctl restart bitfinex-bot
#
# Default content is empty -> engine stays off even with mode set.

# Example (uncomment and customise):
# USD:
#   amount: 0           # 0 = use entire available balance
#   rank: 0.8           # target the p80 of weighted candle volume
#   rankSplit:          # optional: mixed-rank deployment
#     - ratio: 0.3
#       rank: 0.6
#     - ratio: 0.7
#       rank: 0.8
#   rateMin: 0.0001     # ≈ 3.65% APR floor
#   rateMax: 0.01       # ≈ 365% APR ceiling
#   period:             # rate → period (days) mapping
#     3: 0.00027397
#     7: 0.00041096
#     15: 0.00056751
#     30: 0.00082192
YAML_EOF
fi

# ─── 8. write .env ────────────────────────────────────────────────────
log "writing $ENV_FILE"
TMP_ENV="$(mktemp)"
cat > "$TMP_ENV" <<EOF
# Auto-generated by install.sh. Re-run install.sh to refresh from Secret Manager.
BITFINEX_API_KEY=${BITFINEX_API_KEY}
BITFINEX_API_SECRET=${BITFINEX_API_SECRET}
BITFINEX_AFF_CODE=${BITFINEX_AFF_CODE}
BOT_CURRENCIES=USD,UST
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_SUBJECT=mailto:admin@${SLIPIO_DOMAIN}
BOT_API_PORT=8080
BOT_DATA_DIR=${DATA_DIR}
VIEWER_TOKEN=${VIEWER_TOKEN}
PUBLIC_ORIGIN=*
RATE_ALERT_THRESHOLD=0.0006
LARGE_TRADE_MIN_AMOUNT=50000
# Reactive trading (Phase 4)
# mode: off (default, only monitors) | dry_run (compute decisions, log only) | live (actually trade)
STRATEGY_MODE=off
STRATEGY_CONFIG_FILE=${STRATEGY_CONFIG_FILE_DEFAULT}
STRATEGY_DEBOUNCE_MS=1500
STRATEGY_CANDLE_REFRESH_MS=60000
STRATEGY_STATUS_REFRESH_MS=300000
STRATEGY_WARMUP_MS=60000
STRATEGY_MIN_INTERVAL_MS=30000
STRATEGY_MIN_RATE_CHANGE_PCT=1
STRATEGY_DAILY_BUDGET=200
STRATEGY_MIN_AMOUNT_TO_TRADE=1
DEBUG=app:*
EOF

# preserve user-edited values from any existing .env:
#   - bitfinex secrets (only when Secret Manager returned blank this run)
#   - all STRATEGY_* keys (the user owns the trading mode)
#   - VIEWER_TOKEN (don't regenerate; that would invalidate iPhone sessions)
#   - tunable thresholds
preserve_key () {
  local line="$1" key="${1%%=*}"
  if grep -q "^${key}=" "$TMP_ENV"; then
    # escape regex/replacement metachars
    local esc
    esc=$(printf '%s' "$line" | sed -e 's/[\/&]/\\&/g' -e 's/|/\\|/g')
    sed -i "s|^${key}=.*|${esc}|" "$TMP_ENV"
  fi
}
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line; do
    case "$line" in
      BITFINEX_API_KEY=*|BITFINEX_API_SECRET=*|BITFINEX_AFF_CODE=*)
        [[ -z "$BITFINEX_API_KEY" ]] && preserve_key "$line"
        ;;
      VIEWER_TOKEN=*|STRATEGY_*|RATE_ALERT_THRESHOLD=*|LARGE_TRADE_MIN_AMOUNT=*|BOT_CURRENCIES=*|VAPID_*)
        preserve_key "$line"
        ;;
    esac
  done < "$ENV_FILE"
fi

install -o "$BOT_USER" -g "$BOT_USER" -m 600 "$TMP_ENV" "$ENV_FILE"
rm -f "$TMP_ENV"

# ─── 9. systemd service ──────────────────────────────────────────────
log "installing systemd service"
install -m 644 "$INSTALL_DIR/infra/systemd/bitfinex-bot.service" \
  /etc/systemd/system/bitfinex-bot.service
sed -i "s|@INSTALL_DIR@|$INSTALL_DIR|g; s|@BOT_USER@|$BOT_USER|g" \
  /etc/systemd/system/bitfinex-bot.service
systemctl daemon-reload
systemctl enable bitfinex-bot.service

# ─── 10. Caddy reverse proxy ─────────────────────────────────────────
log "configuring Caddy ($SLIPIO_DOMAIN)"
cat > /etc/caddy/Caddyfile <<EOF
{
  email admin@${SLIPIO_DOMAIN}
}

${SLIPIO_DOMAIN} {
  encode zstd gzip
  reverse_proxy localhost:8080
  log {
    output file /var/log/caddy/access.log
  }
}
EOF
mkdir -p /var/log/caddy
systemctl enable caddy
systemctl restart caddy

# ─── 11. start bot ───────────────────────────────────────────────────
log "starting bitfinex-bot"
systemctl restart bitfinex-bot.service
sleep 3
systemctl --no-pager --lines=15 status bitfinex-bot.service || true

# ─── 12. summary ─────────────────────────────────────────────────────
cat <<EOF

================================================================
 ✓ Installation complete
================================================================

 API URL          : https://${SLIPIO_DOMAIN}
 Health endpoint  : https://${SLIPIO_DOMAIN}/api/health
 VAPID public key : ${VAPID_PUBLIC_KEY}
 Viewer token     : ${VIEWER_TOKEN}

 Open your webapp (GitHub Pages) on iPhone:
   1. Add to Home Screen (required for iOS push)
   2. Open the PWA from Home Screen
   3. Tap "連線到 Bot" — paste the API URL and Viewer token
   4. Tap "啟用通知" to subscribe to Web Push

 Service control:
   sudo systemctl status  bitfinex-bot
   sudo systemctl restart bitfinex-bot
   sudo journalctl -u bitfinex-bot -f

 To update later:
   sudo bash ${INSTALL_DIR}/infra/scripts/install.sh

================================================================
EOF
