# Ostrich server operations

Scripts for the VPS. They assume the layout used so far:

| What | Where |
|---|---|
| Repository | `/opt/ostrich` |
| Backend service | `systemd` unit `ostrich` (`/opt/ostrich/backend`) |
| Database settings | `/opt/ostrich/backend/.env` |
| Web app (served by Caddy) | `/var/www/ostrich-web` |

Each script lists its variables at the top if anything is different.

## Deploy

```bash
cd /opt/ostrich
git pull                     # once, to get the scripts themselves
ops/deploy.sh                # backend + web
ops/deploy.sh --web-only     # only the website
ops/deploy.sh --backend-only
ops/deploy.sh --no-backup    # skip the database backup before migrating
```

The script stops at the first error. Before the migration it backs up the
database; after restarting the backend it checks `/api/health` and prints the
service log if the backend does not come up.

## Database migrations

`ops/deploy.sh` runs `npm run db:migrate:prod`, which applies the files in
`backend/migrations/` (`001_*.sql`, `002_*.sql`, ...) that the database has
not had yet, each in a transaction, and records them in `schema_migrations`.
The first run on an existing database applies `001_baseline.sql`, which
matches the old `schema.sql` and changes nothing that is already there.

A schema change is a new file with the next number; files already applied
are never edited.

## Web server headers

The web app sets its Content-Security-Policy itself, but a page cannot
forbid other sites to show it in a frame; the web server has to. In the
Caddyfile, inside the block of the web app's site:

```
header {
	Content-Security-Policy "frame-ancestors 'none'"
	X-Frame-Options "DENY"
	X-Content-Type-Options "nosniff"
	Referrer-Policy "no-referrer"
	Strict-Transport-Security "max-age=31536000"
}
```

Then `systemctl reload caddy`.

## Backups

`ops/backup.sh` writes a compressed `pg_dump` to `/var/backups/ostrich` and
keeps the newest 7. It skips the backup (and fails) when the disk would have
less than 500 MB left. Run it by hand any time:

```bash
ops/backup.sh
KEEP=3 ops/backup.sh
```

### Daily backups

```bash
cp /opt/ostrich/ops/ostrich-backup.service /opt/ostrich/ops/ostrich-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ostrich-backup.timer

systemctl list-timers ostrich-backup.timer   # next run
systemctl start ostrich-backup.service       # run one now
journalctl -u ostrich-backup -n 20           # what happened
ls -lh /var/backups/ostrich
```

How many backups to keep and how much space to leave are set in
`ostrich-backup.service` (`KEEP`, `MIN_FREE_MB`). Check the space first:

```bash
df -h /var/backups
sudo -u postgres psql -d ostrich_db -c "SELECT pg_size_pretty(pg_database_size('ostrich_db'));"
```

Each backup is smaller than the database size shown (it is compressed).
Messages are end-to-end encrypted, so backups contain only ciphertext.

### Restore

```bash
systemctl stop ostrich
sudo -u postgres pg_restore --clean --if-exists -d ostrich_db /var/backups/ostrich/ostrich-YYYYMMDD-HHMMSS.dump
systemctl start ostrich
```

These backups are on the same disk as the database: they protect against
mistakes, not against losing the server. Copy them elsewhere from time to time
(e.g. `scp` to your computer) for that.
