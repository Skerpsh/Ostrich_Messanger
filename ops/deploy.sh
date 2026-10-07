#!/usr/bin/env bash
# Deploys Ostrich on the server: pulls the code, backs up the database,
# builds and migrates the backend, restarts it, checks it answers, and
# publishes the web app.
#
#   ops/deploy.sh                 # backend and web
#   ops/deploy.sh --backend-only
#   ops/deploy.sh --web-only
#   ops/deploy.sh --no-backup     # skip the database backup
#
# Paths and names can be changed with the variables below.
set -euo pipefail

REPO="${REPO:-/opt/ostrich}"
SERVICE="${SERVICE:-ostrich}"
WEB_ROOT="${WEB_ROOT:-/var/www/ostrich-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

backend=1
web=1
backup=1

for arg in "$@"; do
  case "$arg" in
    --backend-only) web=0 ;;
    --web-only) backend=0 ;;
    --no-backup) backup=0 ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "deploy: unknown option $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

cd "$REPO"

step "Pulling the code"
git pull --ff-only

if [ "$backend" = 1 ]; then
  if [ "$backup" = 1 ]; then
    step "Backing up the database"
    "$REPO/ops/backup.sh"
  fi

  step "Building the backend"
  cd "$REPO/backend"
  npm ci
  npm run build

  step "Migrating the database"
  npm run db:migrate:prod

  step "Restarting $SERVICE"
  systemctl restart "$SERVICE"

  step "Checking that the backend answers"
  for _ in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "backend is up"
      break
    fi
    sleep 1
  done

  if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "deploy: the backend does not answer at $HEALTH_URL; last log lines:" >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    exit 1
  fi
fi

if [ "$web" = 1 ]; then
  step "Building the web app"
  cd "$REPO/frontend"
  npm ci
  npm run build:web

  step "Publishing to $WEB_ROOT"
  mkdir -p "$WEB_ROOT"
  # New files first, old ones removed after: the site never goes blank.
  rsync -a --delete-after dist/ "$WEB_ROOT/"
fi

step "Done"
