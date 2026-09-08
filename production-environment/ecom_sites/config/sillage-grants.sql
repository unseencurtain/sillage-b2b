-- Bootstrap for the sillage-core database user.
-- Run as root against ecom-db. Idempotent.
--
--   docker exec -i ecom-db mariadb -uroot -p"$MYSQL_ROOT_PWD" < config/sillage-grants.sql
--
-- SILLAGE_DB_PASSWORD below must match SILLAGE_DB_PASSWORD in sillage-core/.env.

CREATE DATABASE IF NOT EXISTS sillage
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'sillage'@'%' IDENTIFIED BY '__SILLAGE_DB_PASSWORD__';

-- sillage-core owns its own database outright, DDL included.
GRANT ALL PRIVILEGES ON sillage.* TO 'sillage'@'%';

-- Narrow, no-DDL grants on WordPress. This is the complete write surface.
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_posts                        TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_postmeta                     TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_terms                        TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_termmeta                     TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_term_taxonomy                TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_term_relationships           TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_product_meta_lookup       TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_product_attributes_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_category_lookup           TO 'sillage'@'%';

-- Read-only: store settings and, for Stage 2, HPOS order data.
GRANT SELECT ON earth.wp_options                        TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_attribute_taxonomies TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_orders                      TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_order_addresses             TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_order_operational_data      TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_orders_meta                 TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_order_items        TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_order_itemmeta     TO 'sillage'@'%';

-- Deliberately absent: any grant on wp_users, wp_usermeta, or writes to wp_options.

-- WordPress (user lime) reads sil_ean_index, sil_settings, and sil_vendors. Those SELECT
-- grants are applied by bootstrap-sillage.sh / deploy-vps.sh after migrate, because a
-- table-level GRANT requires the tables to exist.

FLUSH PRIVILEGES;
