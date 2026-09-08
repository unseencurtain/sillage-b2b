# Migrate or rebuild on a new VPS

Two honest paths. Prefer A if the old host (`ovhe`) still exists. Use B when you only have
GitHub + secrets + (optional) a Brasty dump.

Photos are **not** in git. Git has the EAN → URL map and a restore script. The JPEG bytes
(~380 MB on the live CDN volume) must be copied or rebuilt.

---

## What GitHub already has

| Path | Role |
|---|---|
| `production-environment/sillage-core/data/image_overrides.json` | Canonical EAN → image URL (~11k keys) |
| `production-environment/sillage-core/data/found-images-manifest.json` | Filenames that must exist on the CDN volume |
| `python-analysis/beautyfort-enriched/restore_found_images.py` | Copy/download those files onto `ecom_sites/data/media/` |
| `python-analysis/beautyfort-enriched/fill_missing_shop_images.py` | Re-match from Brasty + CSVs if the map is lost |
| `python-analysis/beautyfort-enriched/brasty_placeholders.py` | Skip Brasty camera “no photo” graphics |

Hotlinked URLs (Shopify CDN, `images.btswholesaler.com`, oceanfragrances) do **not** need
to sit on disk. Only `https://images.prinscosmetic.eu/<file>` (or your new CDN host) does.

---

## A — Clone the live shop (fastest)

From a laptop that can SSH to **old** and **new**:

```bash
# 1. Fresh host: docs/VPS-DEPLOY.md steps 0–1 (Docker, Caddy, networks)
# 2. Copy secrets (never commit)
scp ovhe:~/sillage/.env ubuntu@NEW:~/sillage/.env
scp ovhe:~/sillage/sillage-core/data/secrets.overlay.env \
    ubuntu@NEW:~/sillage/sillage-core/data/secrets.overlay.env

# 3. Databases + WordPress + CDN files
ssh ovhe 'docker exec ecom-db mariadb-dump -uroot -p"$MYSQL_ROOT_PWD" --all-databases --single-transaction' \
  > /tmp/sillage-db.sql   # or use the root password from old .env inside the dump command on the host
rsync -aH --info=progress2 ovhe:~/ecom_sites/data/ ubuntu@NEW:~/ecom_sites/data/
rsync -a ovhe:~/sillage/sillage-core/data/image_overrides.json \
  ubuntu@NEW:~/sillage/sillage-core/data/image_overrides.json

# 4. Point DNS (shop / dash / images) at NEW, or test via /etc/hosts
# 5. Compose up on NEW with the same image tags, then: docker exec sillage-core bun run migrate
```

Dump MariaDB **on the old host** so the password never hits the laptop command line:

```bash
ssh ovhe 'PW=$(grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-)
docker exec -e MYSQL_PWD="$PW" ecom-db mariadb-dump -uroot --all-databases --single-transaction --routines' \
  | ssh ubuntu@NEW 'cat > /tmp/sillage-db.sql'
```

Import on the new host into `ecom-db` after compose has created the empty volume.

Optional: the old `~/brasty/` dump is gone on ovhe (2026-09-03). Shop photos restore from
`data/media/` + `image_overrides.json` only.

---

## B — GitHub + restore photos (no old VPS)

1. Follow [`VPS-DEPLOY.md`](VPS-DEPLOY.md) until WordPress + dashboard are up.
2. Put vendor keys in `~/sillage/.env` or dashboard **Secrets**.
3. Copy `image_overrides.json` from the clone onto
   `~/sillage/sillage-core/data/image_overrides.json`.
4. Restore CDN files into `~/ecom_sites/data/media/`:

```bash
# On the new VPS, from a clone of this repo
python3 production-environment/python-analysis/beautyfort-enriched/restore_found_images.py \
  --overrides production-environment/sillage-core/data/image_overrides.json \
  --dest ~/ecom_sites/data/media \
  --brasty-root /home/ubuntu/brasty \    # if you copied the dump
  --from-cdn                             # pulls remaining files from images.prinscosmetic.eu
```

`--from-cdn` only works while the **old** CDN still answers. If that host is gone, you need
either a media rsync (path A) or a Brasty dump + matcher rerun.

5. Recreate `sillage-core` / `sillage-cron` so overrides reload.
6. Run a live **Rebuild catalogue** (or `--source=local` only if you have `.feedscratch`).
7. Then content rewrite so Woo picks up override URLs:

```bash
docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
```

### Re-run matching from Brasty (no old CDN)

If you have the dump + ocean/Shopify CSVs but a stale or empty override file:

```bash
# Export shop rows (sku, primary_ean, eans, image_url) then:
python3 fill_missing_shop_images.py \
  --products-json /tmp/shop_products.json \
  --overrides ../../sillage-core/data/image_overrides.json \
  --ocean /path/oceanfragrances.csv \
  --shopify /path/products_export_1.csv \
  --brasty-root /home/ubuntu/brasty \
  --brasty-eans /tmp/brasty_eans.txt \
  --out-delta /tmp/image_overrides.delta.json \
  --out-merged ../../sillage-core/data/image_overrides.json \
  --brasty-copy-list /tmp/brasty_copy.tsv
```

Copy listed files into `data/media/`. Skip placeholder MD5s. Commit the merged JSON back to
GitHub so the next agent does not start from zero.

---

## After migrate checklist

- [ ] Shop, dashboard, images DNS + TLS
- [ ] `hide_products_without_image=1`, `orders_dry_run=1`, `full_sync_enabled=1`
- [ ] Dashboard login works; Sync runs table shows recent success
- [ ] Spot-check a Brasty-filled EAN: `https://images.<domain>/<ean>.jpg` is a product photo,
      not a 404 and not the Brasty camera graphic
- [ ] Bind-mount overrides: `docker exec sillage-core ls /app/data/image_overrides.json`
- [ ] Do **not** place a live vendor order to “test”
