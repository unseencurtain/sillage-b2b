/**
 * Order operations.
 *
 *   bun run orders -- ingest --order=123
 *   bun run orders -- sweep
 *   bun run orders -- show --order=123
 *   bun run orders -- list [--status=received]
 *   bun run orders -- approve --id=1
 *   bun run orders -- dispatch --id=1 [--force] [--live]
 *   bun run orders -- dispatch-order --order=123 [--force] [--live]
 *
 * Without `--live`, dispatch always dry-runs (never spends money), even if `orders_dry_run` is off.
 * `--live` is required to honour a live setting / spend money.
 */
import { env, sil } from "../config/env.ts";
import { closePool, query, waitForDatabase } from "../db/pool.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { approveVendorOrder, dispatchVendorOrder } from "../orders/dispatch.ts";
import { ingestOrder, readWooOrder, sweepDispatchableOrders } from "../orders/ingest.ts";
import { pollDueOrders, pollVendorOrder } from "../orders/tracking.ts";

setLogLevel(env.logLevel);
const log = logger("cli");

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "help";
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name: string): boolean => args.includes(`--${name}`);

const usage = `orders <ingest|sweep|show|list|approve|dispatch|dispatch-order|poll>

  ingest --order=<id>              split a WooCommerce order into one row per vendor
  sweep [--limit=50]               ingest every dispatchable order with no vendor rows
  show --order=<id>                print the order and its vendor rows
  list [--status=...]              list vendor orders
  approve --id=<vendor_order_id>   run pre-quote rails; park at approved if auto_dispatch is off
  dispatch --id=<id> [--force] [--live]
                                   quote + submit one vendor order (dry-run unless --live)
  dispatch-order --order=<wc_id> [--force] [--live]
                                   dispatch every vendor row for a WooCommerce order
  poll [--id=<id>]                 poll one vendor order, or every due order, for tracking`;

function requireOrderId(): number {
  const id = Number(flag("order") ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    log.error("--order=<id> is required");
    process.exit(1);
  }
  return id;
}

try {
  await waitForDatabase();

  switch (command) {
    case "ingest": {
      console.log(JSON.stringify(await ingestOrder(requireOrderId()), null, 2));
      break;
    }

    case "sweep": {
      const results = await sweepDispatchableOrders(Number(flag("limit") ?? 50));
      const created = results.reduce((n, r) => n + r.created.length, 0);
      console.log(`${results.length} order(s) examined, ${created} vendor order(s) created`);
      for (const r of results) {
        for (const c of r.created) {
          console.log(`  order ${r.orderId}  ${c.vendor.padEnd(11)} ${c.reference.padEnd(18)} ${c.lines} line(s)  cost ${c.itemsCost}`);
        }
      }
      break;
    }

    case "show": {
      const orderId = requireOrderId();
      const order = await readWooOrder(orderId);
      if (!order) {
        log.error(`order ${orderId} does not exist`);
        process.exitCode = 1;
        break;
      }
      console.log(JSON.stringify(order, null, 2));
      console.log("\nvendor orders:");
      for (const row of await query<any>(
        `SELECT v.id, v.our_reference, v.status, v.items_cost, v.revenue, v.destination_country,
                ven.slug AS vendor, COUNT(i.id) AS line_count
           FROM ${sil("sil_vendor_orders")} v
           JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
           LEFT JOIN ${sil("sil_vendor_order_items")} i ON i.vendor_order_id = v.id
          WHERE v.wc_order_id = ?
          GROUP BY v.id`,
        [orderId],
      )) {
        console.log(
          `  #${row.id} ${String(row.vendor).padEnd(11)} ${row.our_reference.padEnd(18)} ` +
            `${row.status.padEnd(10)} ${row.line_count} line(s)  cost ${row.items_cost}  revenue ${row.revenue}  -> ${row.destination_country}`,
        );
      }
      break;
    }

    case "list": {
      const status = flag("status");
      const rows = await query<any>(
        `SELECT v.id, v.wc_order_id, v.our_reference, v.status, v.items_cost, v.revenue,
                v.destination_country, v.dry_run, v.created_at, ven.slug AS vendor
           FROM ${sil("sil_vendor_orders")} v
           JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
          ${status ? "WHERE v.status = ?" : ""}
          ORDER BY v.id DESC LIMIT 50`,
        status ? [status] : [],
      );
      if (rows.length === 0) {
        console.log("no vendor orders");
        break;
      }
      for (const r of rows) {
        console.log(
          `  #${String(r.id).padStart(4)} wc=${String(r.wc_order_id).padStart(6)} ${String(r.vendor).padEnd(11)} ` +
            `${r.our_reference.padEnd(18)} ${r.status.padEnd(14)} cost ${String(r.items_cost).padStart(9)} ` +
            `revenue ${String(r.revenue).padStart(9)}  ${r.destination_country}` +
            (r.dry_run ? "  dry-run" : ""),
        );
      }
      break;
    }

    case "approve": {
      const id = Number(flag("id") ?? 0);
      if (!id) {
        log.error("--id=<vendor_order_id> is required");
        process.exitCode = 1;
        break;
      }
      console.log(JSON.stringify(await approveVendorOrder(id, has("force")), null, 2));
      break;
    }

    case "dispatch": {
      const id = Number(flag("id") ?? 0);
      if (!id) {
        log.error("--id=<vendor_order_id> is required");
        process.exitCode = 1;
        break;
      }
      if (has("live")) {
        log.warn("LIVE dispatch: this will spend real money if the rails pass");
      }
      console.log(
        JSON.stringify(
          // Explicit true (not undefined): settings.ordersDryRun may be off on a staging box.
          await dispatchVendorOrder(id, { force: has("force"), dryRun: !has("live") }),
          null,
          2,
        ),
      );
      break;
    }

    case "dispatch-order": {
      const orderId = requireOrderId();
      if (has("live")) log.warn("LIVE dispatch: this will spend real money if the rails pass");
      const rows = await query<any>(
        `SELECT id FROM ${sil("sil_vendor_orders")} WHERE wc_order_id = ? ORDER BY id`,
        [orderId],
      );
      for (const row of rows) {
        const result = await dispatchVendorOrder(row.id, {
          force: has("force"),
          dryRun: !has("live"),
        });
        console.log(JSON.stringify(result));
      }
      break;
    }

    case "poll": {
      const id = Number(flag("id") ?? 0);
      if (id) {
        console.log(JSON.stringify(await pollVendorOrder(id), null, 2));
      } else {
        const n = await pollDueOrders(Number(flag("limit") ?? 50));
        console.log(`polled ${n} order(s)`);
      }
      break;
    }

    default:
      console.log(usage);
  }
} catch (err) {
  log.error(String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closePool();
}
