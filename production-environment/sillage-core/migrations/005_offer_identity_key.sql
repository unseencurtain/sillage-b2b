-- Offer-to-product linking originally joined sil_products on a CASE expression computed from the
-- offer row. An expression is not indexable, so MariaDB fell back to a nested loop of 55k offers
-- against 53k products and the statement ran for over five minutes.
--
-- Materialise the key on the offer instead. The join then becomes an ordinary indexed
-- column-to-column join and completes in well under a second.

ALTER TABLE sil_offers
  ADD COLUMN identity_key VARCHAR(120) NULL AFTER product_id,
  ADD KEY idx_identity (identity_key);
