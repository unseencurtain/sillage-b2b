-- Grants for the wholesale MariaDB (container wholesale-db). Not ecom-db.
-- Placeholders: __SILLAGE_DB_PASSWORD__  __MYSQL_USER__
-- Databases: earth_wpf (WooCommerce), sillage_wpf (engine).
-- WPF in the schema names is the vendor SKU prefix leftover; containers are wholesale-*.

CREATE DATABASE IF NOT EXISTS earth_wpf
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS sillage_wpf
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'sillage'@'%' IDENTIFIED BY '__SILLAGE_DB_PASSWORD__';
ALTER USER 'sillage'@'%' IDENTIFIED BY '__SILLAGE_DB_PASSWORD__';

GRANT ALL PRIVILEGES ON earth_wpf.* TO '__MYSQL_USER__'@'%';
GRANT ALL PRIVILEGES ON sillage_wpf.* TO 'sillage'@'%';
GRANT ALL PRIVILEGES ON earth_wpf.* TO 'sillage'@'%';

FLUSH PRIVILEGES;
