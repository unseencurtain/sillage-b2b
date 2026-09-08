-- Operator pin: keep a SKU off the shop even when stock and photo would show it.
-- Products → Shop dropdown writes this; the writer ORs it onto exclude-from-catalog.

ALTER TABLE sil_products
  ADD COLUMN operator_hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER last_error,
  ADD KEY idx_operator_hidden (operator_hidden);
