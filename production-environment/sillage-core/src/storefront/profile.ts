export { isWholesaleProfile } from "../config/env.ts";

/**
 * Wholesale storefront. Dispatch is always dry-run (no vendor cart/submit).
 * Retail BeautyFort + BTS lives in unseencurtain/Sillage — not this repo.
 */
export function wholesaleMinOrderEur(): number {
  return 300;
}

export function resolveDispatchDryRun(_requested: boolean): boolean {
  return true;
}

export async function applyStorefrontProfile(): Promise<void> {
  const { sil } = await import("../config/env.ts");
  const { execute } = await import("../db/pool.ts");
  const { logger } = await import("../lib/log.ts");
  const log = logger("profile");

  await execute(
    `UPDATE ${sil("sil_vendors")} SET active = 0 WHERE slug IN ('beautyfort', 'bts') AND active <> 0`,
  );
  await execute(
    `UPDATE ${sil("sil_vendors")}
        SET active = 1,
            storefront_label = CASE
              WHEN storefront_label IS NULL OR storefront_label IN ('', 'LPS03') THEN 'Wholesale'
              ELSE storefront_label
            END,
            order_config = JSON_SET(
              COALESCE(order_config, JSON_OBJECT()),
              '$.min_order_value_eur',
              CAST(? AS UNSIGNED)
            )
      WHERE slug = 'wholesale-perfumes'`,
    [wholesaleMinOrderEur()],
  );
  await execute(
    `INSERT INTO ${sil("sil_settings")} (setting_key, setting_value) VALUES
       ('orders_dry_run', '1'),
       ('orders_auto_dispatch', '0')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  );
  log.info(`wholesale profile: WPF active, min order €${wholesaleMinOrderEur()}, dispatch sandbox locked`);
}
