-- Grants for the wholesale MariaDB (container wholesale-db). Not ecom-db.
-- Placeholders: __SILLAGE_DB_PASSWORD__
-- WP app user is lime (created by MYSQL_USER). Engine user is sillage.
-- Databases: earth_wpf (WooCommerce), sillage_wpf (engine).
-- WPF in the schema names is the vendor SKU prefix leftover; containers are wholesale-*.
--
-- These are database-level grants, unlike retail's table-level ones. That is deliberate here:
-- MariaDB refuses a table-level GRANT for a table that does not exist, and on a fresh shop the
-- WooCommerce tables only appear once the operator activates the plugin. A database-level grant
-- applies now and covers those tables the moment they are created.

CREATE DATABASE IF NOT EXISTS earth_wpf
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS sillage_wpf
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'sillage'@'%' IDENTIFIED BY '__SILLAGE_DB_PASSWORD__';
ALTER USER 'sillage'@'%' IDENTIFIED BY '__SILLAGE_DB_PASSWORD__';

GRANT ALL PRIVILEGES ON earth_wpf.* TO 'lime'@'%';
GRANT ALL PRIVILEGES ON sillage_wpf.* TO 'sillage'@'%';
GRANT ALL PRIVILEGES ON earth_wpf.* TO 'sillage'@'%';

FLUSH PRIVILEGES;
