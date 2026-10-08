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

# Everything runs inside main(), which bash reads completely before running
# it: `git pull` below may replace this file, and bash would otherwise go on
# reading the new version from the old position.
main() {

REPO="${REPO:-/opt/ostrich}"
SERVICE="${SERVICE:-ostrich}"
# Several backend processes (ostrich@3001 ostrich@3002 ..., see
# ops/README.md): restarted one after another, each checked on its port,
# so the others keep serving meanwhile.
SERVICES="${SERVICES:-$SERVICE}"
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

  for service in $SERVICES; do
    # ostrich@3001 answers on port 3001; a single service at HEALTH_URL.
    url="$HEALTH_URL"
    port="${service#*@}"

    if [ "$port" != "$service" ]; then
      url="http://127.0.0.1:$port/api/health"
    fi

    step "Restarting $service"
    systemctl restart "$service"

    step "Checking that $service answers"
    for _ in $(seq 1 30); do
      if curl -fsS "$url" >/dev/null 2>&1; then
        echo "$service is up"
        break
      fi
      sleep 1
    done

    if ! curl -fsS "$url" >/dev/null 2>&1; then
      echo "deploy: $service does not answer at $url; last log lines:" >&2
      journalctl -u "$service" -n 30 --no-pager >&2 || true
      exit 1
    fi
  done
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

}

main "$@"
