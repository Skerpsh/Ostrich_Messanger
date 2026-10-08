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

## Several backend processes

One backend process is enough for a long time. For more (several CPU
cores, or restarts without anyone noticing) run several processes behind
Caddy; they share websocket events, who is online, websocket tickets,
failed logins and rate limits through Redis. Without `REDIS_URL` the backend
keeps all of that in memory and must run as one process.

All processes must see the same files of messages (`ATTACHMENTS_DIR`):
on one server they do; on several, put the directory on shared storage.

On the server, one command per step:

1. Redis, only for this machine (Debian/Ubuntu listens on localhost by default):

```bash
apt-get install -y redis-server && systemctl enable --now redis-server && redis-cli ping
```

2. Tell the backend about it:

```bash
grep -q '^REDIS_URL=' /opt/ostrich/backend/.env || echo 'REDIS_URL=redis://127.0.0.1:6379' >> /opt/ostrich/backend/.env
```

3. Two processes on ports 3001 and 3002 instead of the single service (check
first with `systemctl cat ostrich` that it runs as the same user as
`ops/ostrich@.service`, which has none, i.e. root; add `User=` there if not):

```bash
cp /opt/ostrich/ops/ostrich@.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now ostrich@3001 ostrich@3002 && curl -fsS http://127.0.0.1:3001/api/health && curl -fsS http://127.0.0.1:3002/api/health
```

Both should answer with `"redis":"connected"`.

4. In the Caddyfile, the API site's `reverse_proxy 127.0.0.1:3000` becomes
(websockets need nothing more):

```
reverse_proxy 127.0.0.1:3001 127.0.0.1:3002 {
	lb_policy least_conn
	health_uri /api/health
}
```

```bash
systemctl reload caddy && systemctl disable --now ostrich
```

5. Deploys then restart the processes one by one:

```bash
SERVICES="ostrich@3001 ostrich@3002" ops/deploy.sh
```

More processes: another port in steps 3–5. Back to one: the reverse in the
opposite order (`reverse_proxy 127.0.0.1:3000`, `systemctl enable --now
ostrich`, `systemctl disable --now ostrich@3001 ostrich@3002`).

## Monitoring

Two free services watch the server from outside and write to Telegram:

- **UptimeRobot** checks every 5 minutes that the backend answers and sees
  its database.
- **Healthchecks.io** expects a ping from every daily backup and raises the
  alarm when one fails or none comes.

And our own bot on the server reports every 15 minutes (see *Monitoring
bot* below).

### Server down: UptimeRobot

1. Sign up at <https://uptimerobot.com>.
2. *Integrations* → *Telegram* → follow the link to their bot and press
   *Start*: Telegram becomes an alert contact.
3. *New monitor* → type **Keyword**, URL `https://<api address>/api/health`,
   keyword `connected` (*Alert when keyword does not exist*), interval
   5 minutes, alert contact Telegram.

The health check answers `{"status":"ok","database":"connected"}` only when
the backend runs and reaches PostgreSQL, so a stopped database alerts too.

### Monitoring bot

A Telegram bot of our own, running on the server next to the backend
(`backend/src/monitor/`, unit `ostrich-monitor`). Every 15 minutes (at
:00, :15, :30, :45) it sends a silent report: users (total, new, online,
active in a day), messages, database and attachments size, disks, memory,
load, services and the last backup. Every minute it checks the server and
alerts at once, with sound, when a problem has lasted two checks: the
backend does not answer, the database fails, a service failed, a disk or
the memory is nearly full, the last backup is more than 26 hours old; and
again when it is fixed. It answers `/stats` and `/health` in its chats.

It does not replace UptimeRobot above: if the whole server is down, the
bot is down too.

On the server, one command per step:

1. In Telegram, [@BotFather](https://t.me/BotFather) → `/newbot`; copy the
   token it gives. Then put it (instead of `TOKEN`) and a random secret,
   with which the bot asks the backend who is online, into `.env`:

```bash
printf 'MONITOR_BOT_TOKEN=TOKEN\nMONITOR_SECRET=%s\n' "$(openssl rand -hex 32)" >> /opt/ostrich/backend/.env
```

2. Build it and restart the backend, which now knows the secret:

```bash
cd /opt/ostrich && ops/deploy.sh --backend-only --no-backup
```

3. Start the bot:

```bash
cp /opt/ostrich/ops/ostrich-monitor.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now ostrich-monitor
```

4. Write `/start` to the bot: it answers with your chat id. For a group,
   add the bot to it and send `/id` there. Put the id (instead of `ID`;
   several separated by commas) into `.env`:

```bash
echo 'MONITOR_CHAT_IDS=ID' >> /opt/ostrich/backend/.env && systemctl restart ostrich-monitor
```

The bot says "Мониторинг запущен" with a first report. Only these chats
get reports and answers. Deploys restart the bot with the backend.

With several backend processes (above), give it all of their addresses:

```bash
echo 'MONITOR_BACKEND_URLS=http://127.0.0.1:3001,http://127.0.0.1:3002' >> /opt/ostrich/backend/.env && systemctl restart ostrich-monitor
```

Other settings, in `.env` as well (the defaults are shown):

| Variable | Default | |
|---|---|---|
| `MONITOR_REPORT_MINUTES` | `15` | how often to report |
| `MONITOR_CHECK_SECONDS` | `60` | how often to check |
| `MONITOR_ALERT_AFTER` | `2` | checks in a row before an alert |
| `MONITOR_DISK_MIN_FREE_PERCENT` | `10` | a disk is low below this ... |
| `MONITOR_DISK_MIN_FREE_GB` | `2` | ... or this (uploads stop at 1 GB) |
| `MONITOR_MEMORY_MIN_FREE_PERCENT` | `5` | |
| `MONITOR_BACKUP_MAX_AGE_HOURS` | `26` | |
| `MONITOR_SERVICES` | `ostrich* postgresql* redis* caddy*` | systemd services to watch |
| `BACKUP_DIR` | `/var/backups/ostrich` | where `backup.sh` writes |

What it does: `journalctl -u ostrich-monitor -n 30`.

### Files of messages

Photos and files sent in chats are stored encrypted (the server never has
their keys) in `ATTACHMENTS_DIR`, by default `/opt/ostrich/backend/data/attachments`.
Set it in the backend's `.env` to put them on a bigger disk. Uploads are
refused when less than 1 GB would stay free. Files of deleted messages, and
uploads never sent, are removed by the backend within a few hours.

The database backups below do not contain these files. To keep them too,
copy the folder to another machine now and then, e.g. from your computer:

```bash
rsync -a root@SERVER:/opt/ostrich/backend/data/attachments/ ostrich-attachments/
```

## Backups: Healthchecks.io

1. Sign up at <https://healthchecks.io>, *Integrations* → *Telegram* →
   follow the link to their bot.
2. *Add check*: name "Ostrich backup", period **1 day**, grace **2 hours**.
   Copy its ping URL (`https://hc-ping.com/…`).
3. On the server (put your URL in):

```bash
mkdir -p /etc/systemd/system/ostrich-backup.service.d && printf '[Service]\nEnvironment=HEALTHCHECK_URL=https://hc-ping.com/YOUR-UUID\n' > /etc/systemd/system/ostrich-backup.service.d/healthcheck.conf && systemctl daemon-reload && systemctl start ostrich-backup.service
```

The last command runs a backup now: the check turns green. From then on a
failed backup (disk full, database down, …) alerts right away, and a backup
that does not run at all alerts after a day and two hours.

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
