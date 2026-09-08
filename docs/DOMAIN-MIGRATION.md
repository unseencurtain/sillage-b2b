# Change the shop / dashboard / image domains

Changing a name in **one** file is why this always feels broken. The shop, the dashboard, and
the photos each have their own hostname, and **seven different stores** remember those names.
They do not update each other.

**Current live names (30 August 2026)**

| Role | Hostname | What it is |
|---|---|---|
| Shop | `prinscosmetic.eu` | Customer WooCommerce store |
| Dashboard | `sillage.prinscosmetic.eu` | Ops login (Sync, Orders, Settings) |
| Product images | `images.prinscosmetic.eu` | JPEG files from `~/ecom_sites/data/media/` |

Old names (`cosmetic.slilverbelt.xyz`, `sillage.slilverbelt.xyz`, `images.slilverbelt.xyz`)
should stay in DNS pointing at the same VPS **until** every stored URL is rewritten, or you
keep Caddy redirects (step 8).

---

## Why it feels confusing

| You changed… | Still broken because… |
|---|---|
| `.env` only | Caddy still issues certs for the old names; WordPress still thinks it is the old shop |
| Caddy only | Plugin “Open dashboard” still reads `wp-config.php`; product photos still have the old host in the database |
| Settings → Shop URL | That does **not** rewrite photos already saved on products |
| Settings → Image CDN | Same — new syncs use it; existing `_external_thumbnail_url` rows do not |

Do the list below **in order**. Skip none.

```
1. DNS               A records → this VPS
2. ~/sillage/.env    the three hostnames + WP_BASE_URL + LPS_MEDIA_BASE_URL
3. Caddy             TLS + which host goes to shop / dash / images
4. WordPress         siteurl + home  AND  wp-config.php SILLAGE_DASHBOARD_URL
5. Sillage Settings  Shop URL + Image CDN base URL
6. Photos            image_overrides.json  AND  WooCommerce _external_thumbnail_url
7. Recreate          sillage-core + sillage-cron  (overrides are cached in RAM)
```

If the plugin still opens the old dashboard, you skipped **4**.  
If photos are broken squares, you skipped **6** (and usually **3** for the old image host).  
If `https://sillage.new` will not load, you skipped **1** or **3**.

---

## Step-by-step (on the live VPS `ovhe`)

Replace the three names if you ever move again. SSH as `ubuntu`.

### 1. DNS

Create **A** records for shop, dashboard, and images → `139.99.61.71` (this VPS).
Wait until `getent hosts shop.example` shows that IP.

Keep the **old** A records until step 8 is done.

### 2. `~/sillage/.env`

```bash
cd ~/sillage
# edit these five (no trailing slash)
SHOP_DOMAIN=prinscosmetic.eu
DASH_DOMAIN=sillage.prinscosmetic.eu
IMAGES_DOMAIN=images.prinscosmetic.eu
WP_BASE_URL=https://prinscosmetic.eu
LPS_MEDIA_BASE_URL=https://images.prinscosmetic.eu
```

Do **not** change database passwords or `SILLAGE_SHARED_SECRET` here. That is a different job.

### 3. Caddy (`/etc/caddy/Caddyfile`)

Needs **three** site blocks (shop, dashboard, images). Example:

```caddy
prinscosmetic.eu {
	# Required on every shop host — docs/CRAWLER-SHIELD.md
	@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
	handle @heavybot {
		respond "Forbidden" 403
	}
	handle_path /lps-media/* {
		header {
			-Server
			-Via
		}
		reverse_proxy localhost:105 {
			header_down -Server
			header_down -Via
		}
	}
	header {
		-Server
		-Via
		-X-Powered-By
	}
	reverse_proxy localhost:104 {
		header_down -Server
		header_down -Via
		header_down -X-Powered-By
	}
}
sillage.prinscosmetic.eu {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:4000 {
		header_down -Server
		header_down -Via
	}
}
images.prinscosmetic.eu {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:105 {
		header_down -Server
		header_down -Via
	}
}
```

Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy fetches Let’s Encrypt certs by itself. First HTTPS hit can take a minute.

### 4. WordPress public URL + plugin dashboard link

```bash
PW=$(grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-)
docker exec -e MYSQL_PWD="$PW" ecom-db mariadb -uroot earth -e "
  UPDATE wp_options SET option_value='https://prinscosmetic.eu'
   WHERE option_name IN ('siteurl','home');
"

# Plugin “Open the Sillage dashboard” reads wp-config, NOT Settings.
export SILLAGE_DASHBOARD_URL=https://sillage.prinscosmetic.eu
# DASH_DOMAIN in .env is enough if you run:
bash ~/sillage/scripts/vps-bootstrap.sh
# or patch the one line:
python3 - <<'PY'
from pathlib import Path
import re
p = Path("/home/ubuntu/ecom_sites/data/wp/wp-config.php")
t = p.read_text()
t2 = re.sub(
    r"define\(\s*'SILLAGE_DASHBOARD_URL'\s*,\s*'[^']*'\s*\)\s*;",
    "define( 'SILLAGE_DASHBOARD_URL', 'https://sillage.prinscosmetic.eu' );",
    t,
)
p.write_text(t2)
print("patched" if t2 != t else "already")
PY
```

`SILLAGE_CORE_URL` stays `http://sillage-core:4000` (Docker network). Do not put the public
dashboard host there.

### 5. Sillage Settings (or SQL)

Dashboard → **Settings → Shop URLs** → Shop URL + Image CDN base URL → **Save changes**.

Or:

```bash
docker exec -e MYSQL_PWD="$PW" ecom-db mariadb -uroot sillage -e "
  UPDATE sil_settings SET setting_value='https://prinscosmetic.eu' WHERE setting_key='wp_base_url';
  UPDATE sil_settings SET setting_value='https://images.prinscosmetic.eu' WHERE setting_key='image_cdn_base_url';
"
```

Saving the Image CDN **does not** rewrite photos already stored on products. That is step 6.

### 6. Product photos (the usual “images are broken”)

Shop pages store **absolute** URLs. If they still say `https://images.OLDHOST/file.jpg` and
Caddy no longer answers `OLDHOST`, the browser shows a broken image even though the file is
still in `~/ecom_sites/data/media/`.

```bash
# Map used at the next sync
python3 - <<'PY'
from pathlib import Path
p = Path("/home/ubuntu/sillage/sillage-core/data/image_overrides.json")
t = p.read_text()
p.write_text(t.replace("https://images.slilverbelt.xyz", "https://images.prinscosmetic.eu"))
print("overrides rewritten")
PY

# URLs already written into WooCommerce
docker exec -e MYSQL_PWD="$PW" ecom-db mariadb -uroot earth -e "
  UPDATE wp_postmeta
     SET meta_value = REPLACE(meta_value, 'https://images.slilverbelt.xyz', 'https://images.prinscosmetic.eu')
   WHERE meta_key = '_external_thumbnail_url'
     AND meta_value LIKE '%images.slilverbelt.xyz%';
"
```

Shopify / BTS / oceanfragrances URLs stay as-is (those files are not on your VPS).

### 7. Recreate Sillage containers

The override file is **cached in RAM**. `compose restart` is not enough.

```bash
cd ~/sillage
docker compose --env-file .env up -d --force-recreate sillage-core sillage-cron
```

A later **content rewrite** (`full` / `cache` / rewrite-only) will keep writing the new host
from the updated overrides. Fast price sync will not fix photos.

### 8. Optional: keep old hostnames working

While old DNS still points here, add redirects so leftover links and un-rewritten photos work:

```caddy
cosmetic.slilverbelt.xyz {
	redir https://prinscosmetic.eu{uri} permanent
}
sillage.slilverbelt.xyz {
	redir https://sillage.prinscosmetic.eu{uri} permanent
}
images.slilverbelt.xyz {
	redir https://images.prinscosmetic.eu{uri} permanent
}
```

Reload Caddy. Remove these only after you are sure nothing still uses the old names.

---

## Check it worked

```bash
curl -sI https://prinscosmetic.eu/ | head -5
curl -sI https://sillage.prinscosmetic.eu/login | head -5
curl -sI https://images.prinscosmetic.eu/0000030160668.jpg | head -8
grep SILLAGE_DASHBOARD ~/ecom_sites/data/wp/wp-config.php
# should print https://sillage.prinscosmetic.eu
```

| Symptom | Missed step |
|---|---|
| Browser certificate / connection error on the new name | 1 or 2 |
| Shop opens but “Open dashboard” in wp-admin goes to the old host | 4 (`SILLAGE_DASHBOARD_URL`) |
| Dashboard login page loads on the new host, photos broken | 6 (and 2 if the old image host has no Caddy site) |
| Photos work, next sync puts the old image host back | 6 overrides + 7 recreate |
| Settings show the new shop URL, Woo “Visit site” still old | 4 `siteurl` / `home` |

---

## What you should not do

- Do not search-replace the whole MariaDB dump. You will break serialized PHP.
- Do not change `SILLAGE_CORE_URL` to a public HTTPS URL.
- Do not turn **Hide products without image** off to “fix” broken CDN URLs.
- Do not delete `~/ecom_sites/data/` — WordPress, MariaDB, CDN media, sitemaps.

Folder layout after a tidy VPS: [`FOLDER-STRUCTURE.md`](FOLDER-STRUCTURE.md).  
Moving the whole server (not just the name): [`VPS-MIGRATE.md`](VPS-MIGRATE.md).
