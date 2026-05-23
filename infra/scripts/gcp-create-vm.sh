#!/usr/bin/env bash
# gcp-create-vm.sh - Provision the GCP free-tier e2-micro VM in one shot.
# Run this from your local machine (with gcloud installed and authed).
#
# What it does:
#   1. Enables required Google Cloud APIs
#   2. Creates Secret Manager secrets (prompts for values)
#   3. Creates a service account with least-privilege IAM
#   4. Creates the e2-micro VM in a free-tier region with a startup script
#      that runs install.sh on first boot
#   5. Opens firewall for HTTPS (443) and HTTP (80, for Let's Encrypt)
#
# Always-free regions (pick ONE): us-west1, us-central1, us-east1
# Default: us-west1-a (US west, low RTT to Bitfinex edge).

set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-west1-a}"
VM_NAME="${VM_NAME:-lending-bot-vm}"
SA_NAME="${SA_NAME:-lending-bot-sa}"
BRANCH="${BRANCH:-claude/gcloud-realtime-monitoring-eval-EW1aX}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/aa85192/bitfinex-lending-bot-v2}"

if [[ -z "$PROJECT" ]]; then
  echo "ERROR: PROJECT env not set and no default project. Run: gcloud config set project <ID>"
  exit 1
fi

cyan() { printf '\033[1;36m%s\033[0m\n' "$*"; }

cyan "==> using project=$PROJECT, zone=$ZONE, vm=$VM_NAME"

cyan "==> enabling APIs"
gcloud services enable \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT"

cyan "==> creating service account (idempotent)"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Bitfinex Lending Bot" \
    --project="$PROJECT"
fi

cyan "==> creating Secret Manager secrets (interactive)"
prompt_and_create_secret() {
  local name="$1" desc="$2" required="$3"
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    echo "  · $name already exists, skipping (use 'gcloud secrets versions add' to update)"
    return
  fi
  printf '  · enter %s' "$desc"
  [[ "$required" == "1" ]] && printf ' (required)' || printf ' (optional, press enter to skip)'
  printf ': '
  local value
  read -rs value
  echo
  if [[ -z "$value" ]]; then
    if [[ "$required" == "1" ]]; then
      echo "  · skipped required secret '$name' — install.sh will fail until you create it manually"
    fi
    return
  fi
  gcloud secrets create "$name" \
    --replication-policy=automatic \
    --project="$PROJECT"
  printf '%s' "$value" | gcloud secrets versions add "$name" \
    --data-file=- --project="$PROJECT"
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT" >/dev/null
}

prompt_and_create_secret bitfinex-api-key    "Bitfinex API key"    1
prompt_and_create_secret bitfinex-api-secret "Bitfinex API secret" 1
prompt_and_create_secret bitfinex-aff-code   "Bitfinex aff code"   0
prompt_and_create_secret viewer-token        "Viewer token (auto-generated if blank)" 0

cyan "==> creating firewall rules"
if ! gcloud compute firewall-rules describe lending-bot-web --project="$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create lending-bot-web \
    --network=default \
    --direction=INGRESS \
    --allow=tcp:80,tcp:443 \
    --target-tags=lending-bot \
    --description="HTTPS + HTTP-01 challenge for lending bot" \
    --project="$PROJECT"
fi

cyan "==> creating VM (e2-micro, free-tier)"
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  · $VM_NAME already exists in $ZONE; skipping creation"
else
  STARTUP_SCRIPT=$(cat <<EOF
#!/bin/bash
set -e
exec > /var/log/lending-bot-startup.log 2>&1
echo "Starting install at \$(date)"
curl -fsSL ${REPO_RAW}/${BRANCH}/infra/scripts/install.sh | BRANCH=${BRANCH} bash
EOF
  )
  gcloud compute instances create "$VM_NAME" \
    --zone="$ZONE" \
    --machine-type=e2-micro \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --tags=lending-bot \
    --service-account="$SA_EMAIL" \
    --scopes=cloud-platform \
    --metadata=enable-oslogin=TRUE \
    --metadata-from-file=startup-script=<(printf '%s' "$STARTUP_SCRIPT") \
    --project="$PROJECT"
fi

cyan "==> waiting for VM to come up"
sleep 5
EXT_IP="$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
SLIPIO_DOMAIN="${EXT_IP//./-}.sslip.io"

cat <<EOF

================================================================
 ✓ GCP provisioning complete
================================================================
 VM           : $VM_NAME ($ZONE)
 External IP  : $EXT_IP
 API URL      : https://${SLIPIO_DOMAIN}  (HTTPS via Let's Encrypt + sslip.io)
 SSH:           gcloud compute ssh $VM_NAME --zone=$ZONE
 Startup log:   gcloud compute ssh $VM_NAME --zone=$ZONE --command='sudo tail -f /var/log/lending-bot-startup.log'

 The startup script is now installing Node, Caddy, deps, and starting the bot.
 First boot takes ~3-5 min (incl. Let's Encrypt cert).

 Once 'https://${SLIPIO_DOMAIN}/api/health' returns ok:
   1. Open the webapp on your iPhone
   2. Add to Home Screen, open it
   3. Tap "連線到 Bot", paste:
        URL  : https://${SLIPIO_DOMAIN}
        Token: (the value you saved in 'viewer-token' Secret Manager secret)
   4. Tap "啟用通知" to subscribe to push notifications
================================================================
EOF
