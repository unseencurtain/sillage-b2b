-- This shop is wholesale-perfumes only. Undo the retail "park WPF" migration (016)
-- and park leftover BeautyFort/BTS rows if a database was copied from Sillage.
-- Seed the wholesale-perfumes company billing key. Dispatch stays sandbox-locked.

UPDATE sil_vendors
SET active = 1,
    storefront_label = CASE
      WHEN storefront_label IS NULL OR storefront_label IN ('', 'LPS03') THEN 'Wholesale'
      ELSE storefront_label
    END,
    order_config = JSON_SET(
      COALESCE(order_config, JSON_OBJECT()),
      '$.min_order_value_eur',
      300
    )
WHERE slug = 'wholesale-perfumes';

UPDATE sil_vendors SET active = 0 WHERE slug IN ('beautyfort', 'bts') AND active <> 0;

INSERT INTO sil_settings (setting_key, setting_value) VALUES
  ('company_billing_wholesale_perfumes', '{}'),
  ('orders_dry_run', '1'),
  ('orders_auto_dispatch', '0')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
