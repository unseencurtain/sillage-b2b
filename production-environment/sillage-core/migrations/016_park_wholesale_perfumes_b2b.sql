-- Park wholesale-perfumes on the main (LPS retail) storefront.
-- B2B is decoupled to its own future site (see repo top-level b2b-wholesale/).
-- Force inactive so --vendor=all and the scheduler never sync it here.

UPDATE sil_vendors
SET active = 0
WHERE slug = 'wholesale-perfumes';
