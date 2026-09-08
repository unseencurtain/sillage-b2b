#!/usr/bin/env bash
#
# Apply the engine's database grants, then say plainly which ones did not land.
#
# Runs on the VPS, from the stack directory (needs .env and ecom_sites/config/sillage-grants.sql).
#
# MariaDB refuses a table-level GRANT for a table that does not exist — ERROR 1146, and it stops
# reading the file there unless forced. The WooCommerce tables only appear when the operator
# activates WooCommerce, so a deploy that ships plugins inactive can only apply part of this file.
# The rest has to be applied after activation, which is what `deploy-vps.sh --finish` does.
#
#   apply-grants.sh            report what is pending, exit 0 (deploy time, plugins may be off)
#   apply-grants.sh --strict   exit 1 on anything still missing (before the first import)
#
# The failure this prevents is quiet: the import connects fine and then dies on its first write to
# a lookup or order table, which reads like a broken sync rather than a missing privilege.
set -euo pipefail

STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

DB_CONTAINER="${DB_CONTAINER:-wholesale-db}"
SQL="${SQL:-ecom_sites/config/sillage-grants-wholesale.sql}"

[[ -f .env ]] || { echo "no .env in $PWD — run this from the stack directory" >&2; exit 1; }
[[ -f "$SQL" ]] || { echo "missing $SQL" >&2; exit 1; }
set -a; . ./.env; set +a

# No -i: a stdin-reading docker exec inside a read loop swallows the loop's own input.
q() { docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" "$DB_CONTAINER" mariadb -uroot -N -e "$1" </dev/null; }

# --force keeps going past a missing table, so the grants that can apply do.
sed "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" "$SQL" \
  | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" "$DB_CONTAINER" mariadb -uroot --force \
  >/dev/null 2>/tmp/apply-grants.err || true
q "FLUSH PRIVILEGES;" >/dev/null

# What the file asks for: "... ON earth.wp_posts TO 'sillage'@'%';" → "earth.wp_posts sillage"
wanted=$(awk '/^[[:space:]]*GRANT/ {
    tbl = ""; usr = ""
    for (i = 1; i <= NF; i++) {
      if ($i == "ON") { tbl = $(i + 1) }
      if ($i == "TO") { usr = $(i + 1) }
    }
    if (tbl ~ /\./ && usr != "") {
      gsub(/[`;]/, "", tbl)
      sub(/@.*/, "", usr)
      gsub(/'\''|;/, "", usr)
      print tbl, usr
    }
  }' "$SQL" | sort -u)

# What the server actually holds. Table grants live in mysql.tables_priv; a "db.*" grant is a
# database-level one and lives in mysql.db, so both have to be read.
#
# mysql.db stores a *pattern*, so a database whose name contains an underscore can be recorded as
# `earth\_wpf`, and the client escapes backslashes again on the way out. Rather than guess how
# many layers of escaping survived, drop backslashes from both sides before comparing: no database
# or table in this schema has one in its name, so nothing is lost.
held=$(
  { q "SELECT CONCAT(Db, '.', Table_name), User FROM mysql.tables_priv;"
    q "SELECT CONCAT(Db, '.*'), User FROM mysql.db;"
  } | tr '\t' ' ' | tr -d '\\' | sort -u
)
tables=$(q "SELECT CONCAT(table_schema, '.', table_name) FROM information_schema.tables;" | sort -u)

missing=0
pending=0
while read -r qualified user; do
  [[ -z "$qualified" ]] && continue
  if grep -qxF "$qualified $user" <<<"$held"; then
    printf 'ok      %-42s %s\n' "$qualified" "$user"
  elif [[ "$qualified" != *".*" ]] && ! grep -qxF "$qualified" <<<"$tables"; then
    printf 'pending %-42s %s  table does not exist yet — activate WooCommerce\n' "$qualified" "$user"
    pending=$((pending + 1))
  else
    printf 'MISSING %-42s %s  table exists but the grant did not apply\n' "$qualified" "$user"
    missing=$((missing + 1))
  fi
done <<<"$wanted"

if [[ "$missing" -gt 0 ]] || { [[ "$STRICT" -eq 1 ]] && [[ "$pending" -gt 0 ]]; }; then
  echo
  echo "${missing} grant(s) failed, ${pending} waiting on a table that does not exist" >&2
  [[ -s /tmp/apply-grants.err ]] && tail -5 /tmp/apply-grants.err >&2
  exit 1
fi

if [[ "$pending" -gt 0 ]]; then
  echo
  echo "grants applied; ${pending} pending until WooCommerce is activated"
else
  echo
  echo "grants ok"
fi
