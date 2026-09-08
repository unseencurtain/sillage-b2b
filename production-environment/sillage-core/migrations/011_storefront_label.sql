-- Customer-facing shop section labels. Internal slug / sku_prefix / product slug formula stay
-- untouched — those are baked into ~52k SKUs and order history.
--
-- LPS01 = BTS, LPS02 = BeautyFort. The sync renames the existing product_cat root terms in place
-- (same term_id) so category URLs and relationships are not orphaned.

ALTER TABLE sil_vendors
  ADD COLUMN storefront_label VARCHAR(64) NULL AFTER name;

UPDATE sil_vendors SET storefront_label = 'LPS01' WHERE slug = 'bts' AND (storefront_label IS NULL OR storefront_label = '');
UPDATE sil_vendors SET storefront_label = 'LPS02' WHERE slug = 'beautyfort' AND (storefront_label IS NULL OR storefront_label = '');
