# Fresh VPS deploy — wholesale-perfumes (sillage-b2b)

End-to-end recipe for a **brand-new Ubuntu VPS** (nothing installed). This repo does not
need [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage). **Empty VPS** first boot
builds core + WordPress, installs WooCommerce with HPOS, and writes Caddy.  
Target: ~4 GB RAM, public IPv4, SSH key access. Tested on Ubuntu 24.04 / 26.04.

You run everything from your **laptop** in a clone of this repo. The VPS never needs you to paste secrets into chat logs.

---

## What you will have

| Piece | Example |
|---|---|
| Shop (WooCommerce) | `https://shop.example.com` |
| Dashboard (Sillage) | `https://ops.example.com` |
| Product photos | Vendor catalog `flask_front` URLs (not a VPS JPEG CDN) |
| Passwords file (laptop only) | `.deploy/vps-dashboard-<ssh-host>.txt` |

**One compose + one env** on the VPS:

| Path | Role |
|---|---|
| `~/sillage-wholesale/compose.yaml` | Entire stack (wholesale-ecom, wholesale-db, wholesale-valkey, wholesale-core, wholesale-cron) |
| `~/sillage-wholesale/.env` | All secrets + image tags + domains |
| `~/ecom_sites/data/{wp-wholesale,wholesale-db}` | Host volumes (WP, MariaDB). Not `media/` — that is Sillage retail. |
| Host Caddy (`/etc/caddy/Caddyfile`) | TLS edge → `:106` / `:4001`. Shop block **must** include the AI-crawler 403 — [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). No `images.*` site: photos are vendor `flask_front` URLs. The JPEG folder `~/ecom_sites/data/media` is the **Sillage** retail CDN. |

Images are pulled from Docker Hub (`unseencurtain/sillage-b2b:<sha>`, `unseencurtain/sillage-wordpress:<sha>`). Minimal rsync covers compose, config, plugin, and `image_overrides.json` only — **not** a full source-tree sync. After the first deploy, day-2 updates are Hub pull + that thin rsync.

---

## Operator happy path — desired vs reality

**Desired:** fill `.env` → `docker compose up` (Hub pull) → WordPress ready → install Sillage plugin → plugin opens dashboard URL from `.env` → log in → **Run sync now** → products, categories, brands appear.

| Step | Via `deploy-vps.sh` (VPS) | Bare `docker compose up` (local or VPS) |
|---|---|---|
| Fill `.env` | Laptop `.env` seeds vendor keys; script writes remote `~/sillage-wholesale/.env` with generated DB/dashboard secrets | Copy `.env.example` → `.env`; set `MYSQL_*`, `SILLAGE_*`, `DASHBOARD_*`, `SILLAGE_SHARED_SECRET` (and vendor keys or use Secrets UI later) |
| Compose up | Pull + up on VPS; creates Docker networks if missing | **Pre-create** `ecom_network` + `redis_network`; **touch** `sillage-core/data/secrets.overlay.env` (bind mount must be a file) |
| WordPress | **Automated on empty VPS:** `wp_install`, EUR, Blocksy, WooCommerce + redis-cache + sillage-bridge, **HPOS on**, Coming soon **off**, permalinks `/%postname%/` | Official image writes `wp-config.php`; **browser install wizard** unless you run `scripts/wp-fresh-install.php`; **no** WooCommerce/Blocksy/redis-cache auto-install |
| Sillage plugin | Rsynced into `wp-content/plugins/`; activated by deploy script; `vps-bootstrap.sh` patches `wp-config.php` (`SILLAGE_SHARED_SECRET`, `SILLAGE_DASHBOARD_URL`, `SILLAGE_CORE_URL`) | Plugin **files** are in the bind mount but **not activated**; wp-config constants **not** set from `.env` — run `scripts/vps-bootstrap.sh` (VPS) or legacy `ecom_sites/bootstrap-sillage.sh` (split-env local only) |
| Open dashboard | Plugin “Open dashboard” uses `SILLAGE_DASHBOARD_URL` in wp-config (set by deploy), not `DASH_DOMAIN` in `.env` directly | Local: `http://127.0.0.1:4001`. VPS without Caddy: same loopback port; public HTTPS needs host Caddy (`DASH_DOMAIN`) |
| Log in + Sync | Creds in `.deploy/vps-dashboard-<host>.txt`; vendor keys in `.env` or **Secrets** UI; press **Run sync now** | **`docker exec wholesale-core bun run migrate`** first (not run on container start); DB user + grants before health is green; set wholesale-perfumes in Secrets or `.env`; default `sync_source=live` — needs live keys or change to `local` + `.feedscratch` fixtures |
| Products appear | Yes, after sync + finalize REST (bridge must be active, secrets must match) | Same, once bootstrap + migrate + WooCommerce + active bridge are done |

**Already matches (when using the VPS deploy script):** Hub images (core **and** WordPress), single compose + `.env`, unattended fresh WP + WooCommerce + **HPOS** + plugin activation, migrate + MariaDB grants, Caddy TLS, dashboard login file, Sync → catalogue (finalize bumps WC/Blocksy caches).

**Still manual / missing for “compose only”:** external networks, secrets overlay file, migrate, sillage DB user + cross-DB grants, wp-config bridge constants, WooCommerce install, plugin activation, host bootstrap + DNS + Caddy on VPS. Bare compose does **not** run `wp-fresh-install.php` — use **`deploy-vps.sh`** on a VPS.

---

## Prerequisites (laptop)

1. Git clone with vendor credentials:

   ```bash
   cp production-environment/.env.example production-environment/.env
   # Edit vendor keys + dashboard password placeholders
   ```

2. SSH key that can log in as **root** on the new VPS (bootstrap), then as **ubuntu** (deploy).

3. **On a VPS that is `docker login` as `unseencurtain` (ovhe today):** copy `sillage-core`
   **and** `wordpress-image` to `~/sillage-wholesale/`, then `~/sillage-wholesale/scripts/build-push-images.sh`
   (core + WordPress). Pass `--core-only` only for a day-2 engine bump. Do not build Hub
   images on a laptop or cloud agent. The live box is how every existing
   `unseencurtain/sillage-b2b:<sha>` tag was pushed.

4. Two or three DNS names (A records) pointing at the VPS IP — or Porkbun API via `.deploy/porkbun.env` and `--dns`.

---

## Step 0 — Create the VPS

At Hetzner / OVH / etc.: Ubuntu 24.04+, ≥ 4 GB RAM, ≥ 40 GB disk, SSH key attached.  
Firewall: allow **22, 80, 443**.

---

## Step 1 — Bootstrap the host (as root, once)

```bash
ssh root@YOUR_VPS_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh
```

Installs Docker + Compose plugin, Caddy, ufw, fail2ban, `ubuntu` user, and networks `ecom_network` / `redis_network`.

```sshconfig
Host my-sillage
    HostName YOUR_VPS_IP
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
    IdentitiesOnly yes
```

---

## Step 2 — DNS

| Name | Type | Value |
|---|---|---|
| `shop.example.com` | A | VPS IP |
| `ops.example.com` | A | VPS IP |
| `images.example.com` (optional CDN) | A | VPS IP |

---

## Step 3 — One-shot deploy

```bash
./production-environment/scripts/deploy-vps.sh \
  --host my-sillage \
  --shop shop.example.com \
  --dash ops.example.com \
  --dns \
  --ip YOUR_VPS_IP
```

### What the script does

1. Builds and pushes **`sillage-b2b` and `sillage-wordpress`** (omit WordPress only with `--core-only`)
   **on the target VPS** (`docker login` lives there — on ovhe that is `unseencurtain`).
   The laptop/agent that invoked this script does **not** run `docker build`.
2. Rsyncs `compose.yaml`, `ecom_sites/config/`, `sillage-bridge` plugin, `image_overrides.json`,
   `wp-fresh-install.php`
3. Writes `~/sillage-wholesale/.env` once (preserves secrets on later runs)
4. Writes host Caddyfile on an **empty** VPS (`caddy validate` / `reload`). If Caddy already
   serves other hostnames, the file is left alone unless you pass `--replace-caddy`.
5. `docker compose pull && up -d` for the whole stack
6. Fresh WordPress install when `wp-config.php` is missing (or `--fresh`): WooCommerce, HPOS,
   permalinks, Coming soon off
7. Grants + `bun run migrate`
8. Saves dashboard login to **`.deploy/vps-dashboard-<host>.txt`**

Expect ~5–15 minutes the first time (image builds + pulls).

### Day-2 update (Hub on ovhe, then pull)

```bash
# on ovhe (already docker login as unseencurtain)
# after rsync of sillage-core source — do not overwrite ~/sillage-wholesale/sillage-core/data
~/sillage-wholesale/scripts/build-push-images.sh --core-only

# from laptop / repo, after the VPS push:
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop shop.example.com \
  --dash ops.example.com \
  --skip-build
```

Or on the VPS after images are on Hub and compose/env are current:

```bash
ssh my-sillage 'cd ~/sillage-wholesale && docker compose --env-file .env pull && docker compose --env-file .env up -d && docker exec wholesale-core bun run migrate'
```

---

## Step 4 — Verify

```bash
cat .deploy/vps-dashboard-my-sillage.txt

curl -sS -o /dev/null -w "%{http_code}\n" https://shop.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://ops.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://images.example.com/<known-file>.jpg
```

```bash
ssh my-sillage '
  docker ps
  curl -sS http://127.0.0.1:4001/health
  docker inspect wholesale-core --format "{{.Config.Image}}"
'
```

Checklist:

- [ ] Shop and dashboard return **200** over HTTPS  
- [ ] Dashboard login works  
- [ ] Overview page loads  
- [ ] Settings → **Orders dry-run** is **on** for demos  
- [ ] `images.*` CDN serves files from `~/ecom_sites/data/media`  

---

## Local development (same compose)

Bare compose does **not** match the five-step operator story — see [Operator happy path](#operator-happy-path--desired-vs-reality). Minimum after `up`:

```bash
docker network create ecom_network
docker network create redis_network

cp production-environment/.env.example production-environment/.env
# fill MYSQL_* / SILLAGE_* / DASHBOARD_* / SILLAGE_SHARED_SECRET (+ vendor keys or Secrets UI later)
touch production-environment/sillage-core/data/secrets.overlay.env

# optional: build local tags instead of pulling Hub
docker build -t unseencurtain/sillage-wordpress:latest production-environment/wordpress-image
docker build -t unseencurtain/sillage-b2b:latest production-environment/sillage-core

cd production-environment
docker compose --env-file .env --profile local up -d
```

Then manually: complete WP in the browser (`http://localhost` or `:106`), install + activate **WooCommerce**, activate **sillage-bridge**, patch `wp-config.php` with `SILLAGE_SHARED_SECRET` + `SILLAGE_DASHBOARD_URL=http://127.0.0.1:4001` (see `scripts/vps-bootstrap.sh`), create the `sillage` DB user + grants (`ecom_sites/config/sillage-grants-wholesale.sql`), `docker exec wholesale-core bun run migrate`, and lime `SELECT` grants on `sil_*` tables (see deploy script tail). Dashboard: `http://127.0.0.1:4001`.

`shop-gateway` (profile `local`) serves `http://localhost` to `wholesale-ecom`. Product photos are vendor `flask_front` URLs, not `/lps-media`. VPS uses host Caddy instead — do not enable the local profile there.

---

## Security notes

| Item | Expectation |
|---|---|
| Secrets | Only in `~/sillage-wholesale/.env` and laptop `.deploy/` — never commit |
| Ports | Caddy :80/:443 public; app ports on `127.0.0.1` only |
| Identity headers | Caddy strips `Server`, `Via`, and `X-Powered-By` on shop / dash / images. PHP `expose_php=Off`; Apache `ServerTokens Prod` |
| Money | Vendor order APIs have no sandbox; keep dry-run on until intentional |
| Images | Prefer Hub pulls; never commit Docker Hub tokens |

---

## Common failures

| Symptom | Fix |
|---|---|
| `ERR_NAME_NOT_RESOLVED` | DNS / local cache |
| Dashboard SQL denied | Re-run deploy (grants) or apply `ecom_sites/config/sillage-grants.sql` |
| Image pull denied | `docker login` **on ovhe** (already `unseencurtain`); confirm `SILLAGE_CORE_IMAGE` / `WORDPRESS_IMAGE` in `~/sillage-wholesale/.env`. Do not copy Hub credentials off the VPS. |
| `Could not create directory.: /var/www/html/wp-content/upgrade` | Apache is `www-data` (uid 33); `wp-content` was owned by `ubuntu` after bootstrap unzip. On ovhe: `bash ~/sillage-wholesale/scripts/fix-wp-content-perms.sh`. Then retry the dashboard update. |
| `ecom` at 150%+ CPU, cron idle | AI crawler walking `/product`. Confirm UA in Apache access log; Caddy `@heavybot` must be first in the shop site. [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md) |
| Let’s Encrypt fail | DNS must point here; 80/443 open |
| Old split stack still running | Deploy stops `~/redis` + `~/ecom_sites` compose projects before starting `~/sillage-wholesale` |

---

## Scripts reference

| Script | Role |
|---|---|
| `scripts/bootstrap-host.sh` | Fresh OS → Docker + Caddy + ubuntu user |
| `scripts/build-push-images.sh` | Build/push Hub images |
| `scripts/deploy-vps.sh` | App deploy / update |
| `scripts/porkbun-dns.sh` | A-record upsert (`--dns`) |
| `scripts/wp-fresh-install.php` | Empty-VPS WordPress: WooCommerce, HPOS, permalinks |
| `wordpress-image/Dockerfile` | WordPress + Redis PHP extension |

Canonical product facts: [`CONTEXT.md`](CONTEXT.md).

---

## Alternate host deploy — commands only

Live retail shop runs on **`ovhe`** today. SSH **`ovh`** (`51.79.255.226`) is empty/unused.
To deploy to a different VPS (adjust host alias, domains, IP):

```bash
# 1) Ensure laptop production-environment/.env has all vendor + Hub keys
cp -n production-environment/.env.example production-environment/.env

# 2) On the VPS that is docker login (ovhe): rsync sillage-core source, then
#    ~/sillage-wholesale/scripts/build-push-images.sh          # empty VPS / first image: core + WordPress
#    ~/sillage-wholesale/scripts/build-push-images.sh --core-only  # day-2 engine only
#    Do not docker build on the laptop or a cloud agent.

# 3) Deploy compose/plugin (images already on Hub)
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop shop.YOUR_DOMAIN \
  --dash ops.YOUR_DOMAIN \
  --skip-build \
  --ip YOUR_PROD_IP

# 4) Verify
ssh ovh 'cd ~/sillage-wholesale && docker compose --env-file .env ps && curl -sS http://127.0.0.1:4001/health'
```

Single env on prod must be `~/sillage-wholesale/.env`. Keep Settings → Orders dry-run **on**
until intentional live dispatch. Dispatch stays sandbox-locked in this repo (`resolveDispatchDryRun` always true).
