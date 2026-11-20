# Deploying QoreWatch on a VPS

One Debian or Ubuntu server runs everything: the bot, the chain watcher and the web pages, in one Node process behind Caddy (HTTPS). The kit works on a fresh server and on a shared one that already runs other sites and apps (see *Shared servers*). Tested end to end on both: setup, first release, a real testnet alert, a broken release rolled back, a reboot, a database restore and an upgrade.

## What you need

- A Debian or Ubuntu server you can reach over SSH as root or as a user with `sudo`, with ports 80 and 443 free or already served by Caddy.
- A domain (or subdomain) whose DNS `A` record points to the server. Caddy gets the HTTPS certificate for it by itself. No domain yet? `<server-ip>.sslip.io` works as one.
- Your bot token from @BotFather, and `apps/bot/.env` filled in on **your** computer (start from `apps/bot/.env.example`). Set `PUBLIC_URL=https://your.domain`.

The token never goes into git, a chat or a ticket. `ship.sh` uploads the `.env` straight to the server, where it becomes a root-only file.

## Layout on the server

| Path | What | Owner, mode |
| --- | --- | --- |
| `/opt/qorewatch/releases/qorewatch-<commit>/` | one folder per release, built on the server | root, read-only to the bot |
| `/opt/qorewatch/current` | link to the running release | root |
| `/etc/qorewatch/bot.env` | your `.env` (token and settings) | root, 600 |
| `/etc/qorewatch/runtime.env` | fixed paths and port for this layout; wins over `bot.env` | root, 600 |
| `/var/lib/qorewatch/qorewatch.sqlite` | the database | qorewatch, 700 folder |
| `/var/lib/qorewatch/backups/` | daily backups, 14 kept | qorewatch |
| `/etc/caddy/conf.d/qorewatch.caddy` | the HTTPS site, proxy to 127.0.0.1:8787 (or `--port`) | root |
| `/opt/qorewatch/bin/node` | the node QoreWatch runs: a link to the system node (22.13+) or to its own Node 22 in `/opt/qorewatch/node` | root |

The service runs as the `qorewatch` system user (no shell, no login). systemd lets it write only to `/var/lib/qorewatch`, gives it no capabilities, and reads `bot.env` for it, so the bot process cannot read the file itself.

## First deploy

On your computer, from the repository, with the code committed:

```bash
deploy/scripts/ship.sh user@server --env apps/bot/.env
```

It uploads the committed version (`git archive`, so `private/`, `.env` files and anything uncommitted never leave your computer) and the `.env` to `/tmp` on the server, readable only by you. It refuses a commit that tracks anything secret-looking. Then on the server:

```bash
tar -xzf /tmp/qorewatch-<commit>.tar.gz -C /tmp
```

```bash
sudo bash /tmp/qorewatch-<commit>/deploy/scripts/server-setup.sh --domain your.domain [--port 8787]
```

```bash
sudo bash /tmp/qorewatch-<commit>/deploy/scripts/server-release.sh /tmp/qorewatch-<commit>.tar.gz --env /tmp/qorewatch-bot.env
```

```bash
sudo bash /opt/qorewatch/current/deploy/scripts/verify.sh
```

- **`server-setup.sh`** (once; safe to run again) uses the system node if it is 22.13 or newer and otherwise installs a private, checksum-verified Node 22 for QoreWatch only. It installs Caddy from its official repository if missing, creates the user and folders, installs the systemd units and adds the Caddy site. It does not touch the firewall, SSH, other sites or apps, or the system node, npm and pnpm. It stops without changing anything if another web server holds ports 80 or 443, if the bot's port is taken, or if the domain is already a site.
- **`server-release.sh`** installs `bot.env` (and deletes the upload), builds the release as the `qorewatch` user, backs up the database, switches `current`, restarts and waits for `/healthz`. If the new release does not come up, it switches back to the previous one and exits with an error.
- **`verify.sh`** prints PASS or FAIL for 25 points: service, node version, user, secrets' permissions, no `.env` or `private/` in the release, the bot listening on 127.0.0.1 only, health, every page over HTTPS, security headers, the HTTP to HTTPS redirect, the database and the latest backup. It never prints a secret.

On a first deploy the backup line fails until the first backup exists; make one with `sudo systemctl start qorewatch-backup`.

Then open the bot in Telegram, send `/status`, and watch an address.

## Shared servers

On a server that already runs other sites with Caddy and other apps:

- **Pick a free port** for the bot with `--port` (for example `--port 8790` when 8787 is taken). Setup checks it and stops if it is in use. The port is recorded in `/etc/qorewatch/runtime.env`, and every later script reads it from there.
- **Use a domain no other site uses** (for example `qorewatch.<ip-with-dashes>.sslip.io`), and set the same `https://…` address as `PUBLIC_URL` in `.env`.
- **Your Caddyfile stays yours.** Setup backs it up (`Caddyfile.bak-<time>`) and appends one line, `import conf.d/*.caddy`; QoreWatch's site lives in `/etc/caddy/conf.d/qorewatch.caddy`. Caddy checks the change, then applies it with a graceful reload, so the other sites keep running. If Caddy refuses it, the backup is put back. Only the Caddy package's untouched placeholder file is ever replaced.
- **Other apps' Node stays as it is.** If the system node is older than 22.13, QoreWatch runs its own Node 22 from `/opt/qorewatch/node`.
- **Resources:** the service is capped at 700 MB of memory (it uses about 60-200 MB) with a lower CPU weight. Each kept release takes about 300 MB of disk, the private Node about 200 MB.

To remove QoreWatch's site later: delete `/etc/caddy/conf.d/qorewatch.caddy` and run `sudo systemctl reload caddy`.

## Updates

Commit, then ship and release the new commit (no `--env` unless the settings changed):

```bash
deploy/scripts/ship.sh user@server
```

```bash
sudo bash /tmp/qorewatch-<commit>/deploy/scripts/server-release.sh /tmp/qorewatch-<commit>.tar.gz
```

(Unpack the archive first, as above, so the newest `server-release.sh` runs.) The three newest releases are kept. To change a setting only, edit `/etc/qorewatch/bot.env` as root and run `sudo systemctl restart qorewatch`.

## Day to day

| | |
| --- | --- |
| Status | `systemctl status qorewatch` |
| Logs | `journalctl -u qorewatch -f` (Caddy: `journalctl -u caddy`) |
| Health | `curl -s 127.0.0.1:8787/healthz` |
| Restart | `sudo systemctl restart qorewatch` |
| Backup now | `sudo systemctl start qorewatch-backup` |
| Full check | `sudo bash /opt/qorewatch/current/deploy/scripts/verify.sh` |

## Restore a backup

```bash
sudo systemctl stop qorewatch
```

```bash
sudo -u qorewatch cp /var/lib/qorewatch/backups/<file>.sqlite /var/lib/qorewatch/qorewatch.sqlite
```

```bash
sudo rm -f /var/lib/qorewatch/qorewatch.sqlite-wal /var/lib/qorewatch/qorewatch.sqlite-shm
```

```bash
sudo systemctl start qorewatch
```

The watcher catches up on the blocks it missed (up to `MAX_CATCHUP_BLOCKS`).

## If the token leaks

Revoke it in @BotFather (`/revoke`), put the new token in `/etc/qorewatch/bot.env` as root, and restart the service. Nothing else holds it.

## Firewall

The setup script leaves the firewall to you. QoreWatch needs only 80 and 443 open to the world (and your SSH port); port 8787 listens on 127.0.0.1 only.
