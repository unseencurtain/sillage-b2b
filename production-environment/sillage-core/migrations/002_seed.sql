-- Baseline settings and the two vendors. Re-runnable: INSERT IGNORE never overwrites operator edits.

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  -- Pricing. A plain float multiplier: 0.5, 1.2 and 2 are all valid.
  ('global_price_multiplier',   '1.0'),
  -- stock <= threshold hides the product AND forces outofstock.
  ('global_stock_threshold',    '0'),
  -- Cross-vendor dedupe. 2,646 EANs appear in both feeds; without this they become duplicates.
  ('dedupe_by_ean',             '1'),
  -- Which offer wins for a deduped product: 'cheapest' or 'most_stock'. Always filtered to
  -- in-stock offers from vendors that can ship to the destination.
  ('primary_offer_strategy',    'cheapest'),
  -- Both feeds ship 100% empty descriptions. 'none' leaves them blank, 'template' generates copy
  -- from brand, type, size and collection.
  ('description_mode',          'none'),
  ('write_batch_size',          '500'),
  -- Cap on a single multi-row INSERT. max_allowed_packet is 64M; this leaves generous headroom.
  ('max_statement_bytes',       '4194304'),

  -- Stage 2 safety rails. Every vendor order spends real money and neither API has a sandbox.
  ('orders_dry_run',            '1'),
  ('orders_auto_dispatch',      '0'),
  ('orders_max_value_eur',      '500'),
  ('orders_daily_cap_eur',      '2000'),
  ('orders_poll_minutes',       '15'),
  ('orders_notify_customer',    '1');

INSERT IGNORE INTO sil_vendors
  (slug, name, sku_prefix, currency, fx_rate, serviceable_countries, order_config, active)
VALUES
  (
    'beautyfort', 'BeautyFort', 'BF', 'EUR', 1.0,
    -- Confirmed from getAccountInformation: 7 countries, flat EUR rates 7.15-10.65.
    '["BE","DE","ES","IT","NL","PT","SE"]',
    '{"orderType":"Direct Dispatch","attemptAutomaticPayment":false}',
    1
  ),
  (
    'bts', 'BTS Wholesaler', 'BTS', 'EUR', 1.0,
    -- Confirmed from getCountries: 25 EU states (all but CY and MT) plus CH, GB, MC.
    '["AT","BE","BG","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","NL","PL","PT","RO","SE","SI","SK","CH","GB","MC"]',
    '{"paymentMethod":"banktransfer","dropshipping":1,"shippingStrategy":"cheapest"}',
    1
  );
