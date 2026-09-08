-- Per-order delivery / billing snapshots (Sillage-owned; never written back to WooCommerce)
-- plus empty company billing profile keys for BeautyFort and BTS invoices.

ALTER TABLE sil_vendor_orders
  ADD COLUMN delivery_address_json JSON NULL AFTER destination_country,
  ADD COLUMN billing_address_json  JSON NULL AFTER delivery_address_json;

INSERT INTO sil_settings (setting_key, setting_value) VALUES
  ('company_billing_beautyfort', '{}'),
  ('company_billing_bts', '{}')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
