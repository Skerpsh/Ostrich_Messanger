#!/usr/bin/env bash
# Backs up the Ostrich database (compressed pg_dump) and keeps only the
# newest KEEP backups. Skips the backup when the disk is nearly full.
#
#   ops/backup.sh                       # with the defaults below
#   KEEP=3 BACKUP_DIR=/srv/backups ops/backup.sh
#
# Run daily by ops/ostrich-backup.timer (see ops/README.md).
# Restore: pg_restore --clean --if-exists -d ostrich_db <file>
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ostrich}"
KEEP="${KEEP:-7}"
# Database connection: the backend's .env (DB_HOST, DB_PORT, DB_NAME,
# DB_USER, DB_PASSWORD).
ENV_FILE="${ENV_FILE:-/opt/ostrich/backend/.env}"
# Space that must stay free on the disk besides the new backup.
MIN_FREE_MB="${MIN_FREE_MB:-500}"
# Optional: a Healthchecks.io ping URL (see ops/README.md). A backup pings
# it, a failure pings its /fail, and no ping for a day raises an alarm.
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

ping_healthcheck() {
  if [ -n "$HEALTHCHECK_URL" ]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "$HEALTHCHECK_URL$1" || true
  fi
}

# Any failing command reports the failure.
trap 'ping_healthcheck /fail' ERR

fail() {
  echo "backup: $*" >&2
  ping_healthcheck /fail
  exit 1
}

if [ ! -r "$ENV_FILE" ]; then
  fail "cannot read $ENV_FILE"
fi

# Reads KEY=VALUE lines without running the file as a script (a password
# with $, quotes or spaces must not break it or run anything). Matching
# quotes around a value are removed, like dotenv does.
env_value() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi

  printf '%s' "$value"
}

DB_HOST="$(env_value DB_HOST)"
DB_PORT="$(env_value DB_PORT)"
DB_NAME="$(env_value DB_NAME)"
DB_USER="$(env_value DB_USER)"
DB_PASSWORD="$(env_value DB_PASSWORD)"

export PGHOST="${DB_HOST:-localhost}"
export PGPORT="${DB_PORT:-5432}"
export PGDATABASE="${DB_NAME:-ostrich_db}"
export PGUSER="${DB_USER:-ostrich}"
export PGPASSWORD="${DB_PASSWORD:-}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# A compressed dump is smaller than the database; its size is an upper
# bound for the space the backup needs.
db_bytes="$(psql -tAc "SELECT pg_database_size(current_database())")"
free_bytes="$(df --output=avail -B1 "$BACKUP_DIR" | tail -n 1 | tr -d ' ')"
needed_bytes=$((db_bytes + MIN_FREE_MB * 1024 * 1024))

if [ "$free_bytes" -lt "$needed_bytes" ]; then
  fail "skipped, not enough disk space in $BACKUP_DIR" \
    "($((free_bytes / 1024 / 1024)) MB free, need $((needed_bytes / 1024 / 1024)) MB)"
fi

file="$BACKUP_DIR/ostrich-$(date +%Y%m%d-%H%M%S).dump"

# Written under a temporary name, so a failed dump never looks complete.
pg_dump --format=custom --compress=6 --file="$file.partial"
mv "$file.partial" "$file"
chmod 600 "$file"

# Keep the newest KEEP backups.
find "$BACKUP_DIR" -maxdepth 1 -name 'ostrich-*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n +"$((KEEP + 1))" \
  | cut -d' ' -f2- \
  | xargs -r rm --

count="$(find "$BACKUP_DIR" -maxdepth 1 -name 'ostrich-*.dump' | wc -l)"
echo "backup: $file ($(du -h "$file" | cut -f1)), $count kept in $BACKUP_DIR"
ping_healthcheck ""
