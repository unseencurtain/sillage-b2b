# Scratch reset — restore path

Baseline taken before wiping the ovhe shop catalogue and splitting B2B into its own repo.

## Tag

| Item | Value |
|---|---|
| Annotated tag | `pre-scratch-20260808` |
| Commit | `31d63de1fedab42f41a04af23438bb6165379d36` |
| Remote | `git@github.com:unseencurtain/Sillage.git` |

```bash
git fetch origin tag pre-scratch-20260808
git checkout pre-scratch-20260808
# or: git reset --hard pre-scratch-20260808   # only if you intend to move a branch tip
```

## Hub images from that tip

Build locally (same Dockerfiles deploy uses):

```bash
docker build -t unseencurtain/sillage-wordpress:pre-scratch-20260808 \
  production-environment/wordpress-image
docker build -t unseencurtain/sillage-core:pre-scratch-20260808 \
  production-environment/sillage-core
```

Optional push (needs Hub login):

```bash
docker push unseencurtain/sillage-wordpress:pre-scratch-20260808
docker push unseencurtain/sillage-core:pre-scratch-20260808
```

Day-2 deploy still tags by git SHA; the `pre-scratch-*` tags are restore markers, not the compose default.

## Database restore (ovhe)

Phase C dumps (taken before the catalogue wipe):

```text
~/sillage/backups/pre-scratch-20260807-212049-earth.sql.gz
~/sillage/backups/pre-scratch-20260807-212049-sillage.sql.gz
```

Typical restore:

```bash
ssh ovhe
cd ~/sillage
set -a; source .env; set +a
gunzip -c backups/pre-scratch-20260807-212049-earth.sql.gz \
  | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot earth
gunzip -c backups/pre-scratch-20260807-212049-sillage.sql.gz \
  | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot sillage
```

Credentials come from `~/sillage/.env` on the VPS. Media files under `~/ecom_sites/data/media` are not in the SQL dump — leave them on disk unless you deliberately wipe them.

## B2B code

Live wholesale is in this repo (`SILLAGE_PROFILE=wholesale`, [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md)).
[sillage-b2b](https://github.com/unseencurtain/sillage-b2b) is the August 2026 extract archive — do not deploy it.
`b2b-wholesale/` is a pointer. The pre-scratch tag still contains the older in-tree scaffold.

## What this does *not* restore

- Live vendor catalogue state after a new sync (re-run sync from the restored code tip)
- Docker Hub image layers you never pushed (rebuild from the tag)
- Secrets (always in gitignored `.env` files)
