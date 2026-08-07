# wholesale-perfumes vendor package (extracted)

Canonical home for the SoleLuna / wholesale-perfumes.eu connector formerly parked under
`unseencurtain/Sillage` (`production-environment/sillage-core/...`).

| Piece | Path |
|---|---|
| Connector | `src/vendors/wholesale-perfumes/` |
| Order adapter | `src/orders/adapters/wholesale-perfumes.ts` |
| Unit tests | `tests/wholesalePerfumes.test.ts` |
| Fixtures | `tests/fixtures/wholesale_perfumes_*.xml` |
| Seed migration | `migrations/013_wholesale_perfumes_vendor.sql` |
| Park-on-retail migration | `migrations/016_park_wholesale_perfumes_b2b.sql` |

These files still compile inside the retail Sillage tree until that connector is deleted there.
Wire this package into a dedicated B2B Sillage/WordPress stack — do **not** re-enable on the
cosmetic retail shop (`cosmetic.slilverbelt.xyz`).

API notes: [`../docs/wholesale-perfumes-api.md`](../docs/wholesale-perfumes-api.md).
Env template: [`../env/.env.example`](../env/.env.example).
