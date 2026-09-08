-- wholesale-perfumes.eu (SoleLuna spol. s.r.o.): vendor seed + VAT column.
-- Catalog ≤1 download/day; store (price/stock) may run hourly.
-- Live-feed caps live on sil_vendors columns (migration 014), not sil_settings keys.

-- Repair a stray pre-rename row if present (never DELETE).
UPDATE sil_vendors SET slug = 'wholesale-perfumes', sku_prefix = 'WPF' WHERE slug = 'ocean';

-- Ex-VAT prices need a vendor-level VAT uplift before markup tiers. Default 0 leaves
-- BeautyFort and BTS numbers unchanged.
ALTER TABLE sil_vendors
  ADD COLUMN vat_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0000
    COMMENT 'Fraction added to vendor_price before markup: cost = price × fx × (1+vat_rate)'
    AFTER fx_rate;

-- OPERATOR-CONFIRMABLE guesses below (min_order_value_eur, serviceable_countries, vat_rate).
-- Seed inactive so nothing syncs until an operator turns the vendor on deliberately.
INSERT IGNORE INTO sil_vendors
  (slug, name, storefront_label, sku_prefix, currency, fx_rate, vat_rate,
   serviceable_countries, order_config, active)
VALUES
  (
    'wholesale-perfumes',
    'wholesale-perfumes.eu (SoleLuna)',
    'LPS03',
    'WPF',
    'EUR',
    1.0,
    -- GUESS: leave 0 until the operator confirms the correct VAT fraction for price_no_vat.
    0.0000,
    -- From https://www.wholesale-perfumes.eu/shipping-payment/ (pricelist from 2025-10-18).
    '["AT","BE","BG","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HR","HU","IT","LT","LV","NL","PL","PT","RO","SE","SI","SK"]',
    -- GUESS: min_order_value_eur=100 — client confirmed a MOQ exists but not the amount.
    '{"min_order_value_eur":100}',
    0
  );

-- Keep serviceable countries aligned if the row already existed with an older guess.
UPDATE sil_vendors
SET serviceable_countries = '["AT","BE","BG","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HR","HU","IT","LT","LV","NL","PL","PT","RO","SE","SI","SK"]'
WHERE slug = 'wholesale-perfumes';
