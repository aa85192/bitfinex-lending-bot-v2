#!/usr/bin/env bash
# update.sh - Pull latest code and restart the bot.
# Run on the VM via:  sudo bash /opt/bitfinex-lending-bot/infra/scripts/update.sh

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/bitfinex-lending-bot}"
BOT_USER="${BOT_USER:-lendingbot}"
BRANCH="${BRANCH:-$(cd "$INSTALL_DIR" && git rev-parse --abbrev-ref HEAD)}"

cd "$INSTALL_DIR"
sudo -u "$BOT_USER" git fetch origin "$BRANCH"
sudo -u "$BOT_USER" git reset --hard "origin/$BRANCH"
sudo -u "$BOT_USER" npm install --omit=dev --no-audit --no-fund
sudo -u "$BOT_USER" npm install --no-save tsx@^4 --no-audit --no-fund
systemctl restart bitfinex-bot.service
systemctl --no-pager --lines=10 status bitfinex-bot.service
