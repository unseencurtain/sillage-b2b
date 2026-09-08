# How to use Sillage — client guide

**This is the human guide.** It is written for the people who run the shop and the operations
dashboard — not for developers. Button names and page titles match what you see on screen.

**Live sites (September 2026)**

| What | Address |
|---|---|
| Customer shop (retail) | https://prinscosmetic.eu |
| Operations dashboard (retail) | https://sillage.prinscosmetic.eu |
| Track an order (retail customers) | https://prinscosmetic.eu/track-order/ |
| Wholesale shop | https://wholesale.mirainikki.xyz |
| Wholesale operations dashboard | https://sillage-wholesale.mirainikki.xyz |

The wholesale shop is a **different website**: different catalogue (wholesale-perfumes only),
**€300 minimum order**, and vendor dispatch is **sandbox-only** (dry-run — it does not place a
real order at the supplier). Do not mix it up with the retail BeautyFort + BTS shop.

Ask the operator who deployed the shop for the dashboard password. It is **not** in this repository.
Retail and wholesale dashboards use the **same** operator user (`admin` in `DASHBOARD_USER`); the
password lives only in `~/sillage/.env` on the VPS. Wholesale wp-admin is a separate WordPress
user (`admin` @ wholesale.mirainikki.xyz); that password is `WHOLESALE_WP_ADMIN_PASS` in the same file.

---

## Keep this document current

When the **dashboard labels**, **Settings knobs**, **shopper rules** (cart, checkout, tracking),
or **what a sync actually does** change, update **this file in the same change**.

- Developers / agents: see the rule in [`AGENTS.md`](../AGENTS.md).
- Screen-by-screen engineering notes (APIs, database keys) live in
  [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) — that file is for builders, not clients.
- A short **demo script** for a live walkthrough is [`CLIENT-FEATURE-WALKTHROUGH.md`](CLIENT-FEATURE-WALKTHROUGH.md).

*Last reviewed against the live dashboard: 8 September 2026.*

---

## 1. What Sillage is, in one page

You sell perfume and cosmetics online. Two wholesalers supply the goods:

- **BeautyFort**
- **BTS Wholesaler**

Sillage does three jobs:

1. **Keeps the shop catalogue in step with those wholesalers** — products, prices, stock,
   categories, brands. Tens of thousands of listings; nobody maintains that by hand.
2. **Lets you set the selling price** as a markup on wholesale cost (for example 1.5×).
3. **Turns a paid customer order into a dropship order** at the right wholesaler, then brings
   tracking back when the parcel exists.

Shoppers never see “BeautyFort” or “BTS” as shop categories. They see brands, product types, and
normal WooCommerce pages. The dashboard is for **you**.

A third wholesaler (wholesale-perfumes) is **not** on the retail shop. It is sold on the
separate wholesale site (https://wholesale.mirainikki.xyz) with a **€300** minimum order.

---

## 2. Two websites — do not mix them up

**The shop** is what customers use: browse, cart, checkout, “where is my order?”.

**The dashboard** (Sillage) is what you use: sync the catalogue, change markup, approve vendor
orders, paste API keys.

| Shop | Dashboard |
|---|---|
| Public | Password protected |
| WooCommerce / WordPress | Sillage operations app |
| Changing a product here by hand is fighting the sync | Catalogue truth comes from the wholesalers + your Settings |

You do **not** need to edit thousands of products in WordPress. Change markup or visibility in
**Settings**, let a rewrite run, and the shop updates.

---

## 3. Money — read this before Orders

Neither wholesaler has a test/sandbox order API. **Live** dispatch spends real money.

Safe defaults (keep them unless you mean to spend):

- Settings → **Order safety** → **Orders dry-run** = **on**
- Settings → **Order safety** → **Auto-dispatch** = **off**

What that actually means:

- **Dry-run** on a single order: Sillage builds the real payload and checks stock/shipping.
  **Nothing is placed** at the wholesaler.
- **Live** on a single order: after an on-screen confirm, the order **is** placed. You pay the
  wholesaler.
- The Settings dry-run switch does **not** freeze the **Live** button. Live always spends if you
  confirm it. The switch mainly protects **automatic** dispatch and command-line tools.
- If dry-run is **off** and auto-dispatch is **on**, the system can place vendor orders **without
  you clicking**. Do not combine those two.

The dashboard shows a red banner when dry-run is off.

---

## 4. Sign in

1. Open https://sillage.prinscosmetic.eu
2. **User** is usually `admin`
3. Enter the password you were given → **Sign in**
4. Use **Sign out** at the bottom of the left menu when you are done

Invalid login shows **Invalid credentials**. There is no self-service password reset in the app;
ask whoever holds the server secrets.

---

## 5. How the catalogue actually works

Think of a loop, not a one-off import.

1. **Secrets** hold the BeautyFort and BTS API keys (set once; you never see the values again).
2. **Rebuild catalogue** (on **Sync**) creates and structures products the first time, and later
   when you need new products and categories in WordPress.
3. **Sync enabled** (on **Settings**) leaves the shop on a schedule. **Minutes between syncs**
   (same Settings page) is the interval — 30, 40, or whatever you set. That is how often it
   **checks** the wholesalers for price and stock. It is not a fixed 30 minutes in the code.
4. **Daily full catalogue rebuild** (on **Settings**, keep this **on**) does a deeper refresh once
   per day (new products, WordPress categories). The hour is in **Operator timezone** (this shop
   uses Asia/Dhaka unless you change it).

How often prices really move on the shop:

- **BeautyFort** — every successful check (your **Minutes between syncs**). They do not offer a
  “only what changed” feed, so each check downloads their stock file.
- **BTS** — **about once a day** on the shop. We still *check* on that same interval. Empty checks
  are normal until BTS publishes their daily change batch. That is their feed, not a hidden cap.

**Stop** on the Sync page aborts a run that is in progress and turns **Sync enabled** **off**.
Turning it back on is a Settings change. Pressing **Update prices & stock** does **not** by itself
turn the schedule back on.

Changing the **price multiplier** (or tiers, stock threshold, hide-without-image) and clicking
**Save changes** starts a **price rewrite** from data already in Sillage. It does **not** call the
wholesaler again. Wait for the toast (“Recalculating prices…”). Then check a product on the shop.

---

## 6. The dashboard, page by page

Left menu, top to bottom — the same words as the screen.

### Overview

Health at a glance. Numbers refresh on their own.

| You see | Meaning |
|---|---|
| **Visible in shop** | Listings customers can find in the catalogue. This is **smaller** than Published when hide-without-image or out-of-stock is on — a successful rebuild of 19k products does not mean 19k visible |
| **Published in WP** | Also includes products that are published but **hidden** from the shop loop |
| **Sillage products** | Everything Sillage tracks |
| **Sync on / off** and **orders: dry-run / LIVE** | Snapshot of the two big switches |
| **Catalogue visibility** | Hidden reasons are exclusive and **add up**: no/weak image, out of stock (has a photo), pinned. Visible + Hidden = Published. The Out of stock card is the WooCommerce stock term (some of those also lack a photo) |
| **Update prices & stock** / **Scheduled (30m)** | Same action as on Sync. Greyed out while the schedule is on — that is intentional |

This page **never** places a vendor order.

### Sync

This is the catalogue control room.

| Button | What it does |
|---|---|
| **Update prices & stock** | One-off price/stock refresh from the wholesalers. Disabled while **Sync enabled** is on (the schedule already owns that job) or while a vendor is in its wait interval |
| **Rebuild catalogue** | Full structure: new products, categories, vanish what the wholesaler no longer sells. If the schedule is on and the shop already has a catalogue, this **queues** for the next scheduled slot (**Rebuild queued**) |
| **Stop** | Only while a run is active. Aborts between batches and turns **Sync enabled** off |

The **runs table**:

- **Fetched** — retail: `BF n · BTS m` (a **Δ** on BTS means the “what changed” API). Wholesale: `WPF n` catalogue SKUs compared, **not** the raw hourly store XML line count (that file has many rows per product).
- **Shop writes** — `New n · Updated n · Prices n` (new WooCommerce products, listing/content
  rewrites including photos, price/stock writes). Not `+ ~ $`. A prices & stock run right after a rebuild often writes **0** — the shop already has those prices.

Empty checks for BTS are success, not failure.

### Products

Search **SKU, name, or EAN**.

Columns: **Photo**, **SKU**, **Name**, **Vendor**, **Stock**, **Shop**, **Cost**, **WP**.

**Photo** opens the image the shop would print, in a new tab. No usable photo → **No photo** (or a
link to the product page if one exists).

**Shop** is a dropdown plus a reason badge.

| Dropdown | What happens |
|---|---|
| **Follow rules** | Hide-without-image and the stock threshold decide. The next rewrite can show the product again if it has a real photo and enough stock. |
| **Keep hidden** | Stays off the catalogue and search even when stock and photo would show it. Use this for a bad or wrong photo. The next rewrite keeps it hidden. |

| Badge | Meaning |
|---|---|
| **Visible** | In the shop catalogue, with a real `http(s)` photo |
| **Hidden · no image** | WooCommerce has no usable photo (empty, `None`, placeholder, or a tiny BeautyFort `/pic/` thumb). Stock can still be 1. |
| **Hidden · stock** | At or below the stock threshold |
| **Hidden · pinned** | You chose **Keep hidden** |

Do not delete a product in WooCommerce to hide it. The next catalogue rewrite will create it
again. Use **Keep hidden** instead.

**Cost** is wholesale cost, not the selling price. Selling price is cost × your multiplier (and
tiers / FX / VAT when those are set).

Do not turn **Hide products without image** off shop-wide just to unhide one SKU. That would also
show thousands of weak BeautyFort thumbs. Ask for a real photo on that EAN instead.

### Vendors

Cards for **BeautyFort** and **BTS** only.

Typical fields: storefront label (internal lane name such as LPS01 / LPS02 — **not** a shop
category), **price multiplier**, **min visible stock**, FX, VAT, minimum order value, countries
you can ship to, **Active**.

Save a multiplier / FX / VAT / min stock → the same automatic **price rewrite** as Settings.

**How often this vendor updates** on the card explains BeautyFort vs BTS (see §5). Last live fetch
is shown there.

wholesale-perfumes appears as a **read-only parked** card. Do not try to activate it on this shop.

API keys are **not** on this page. Use **Secrets**.

### Orders

Each row is **one wholesaler’s slice** of a WooCommerce order (`SIL-…-BF` or `SIL-…-BTS`), not the
WooCommerce order itself. A mixed cart cannot happen (the shop blocks it), so you normally see one
row per customer order.

Typical path for a **test** (keep dry-run on):

1. A paid order appears on the shop (status processing).
2. Sillage creates the vendor row.
3. **Approve** if needed (country and spend ceilings).
4. **Dry-run** — inspect the payload. No money.
5. Only when you intend to buy from the wholesaler: **Live**, then confirm the dialog.

You can edit **ship-to** before a live submit. That does **not** change the address inside
WooCommerce; it only changes what we send the wholesaler.

**Tracking** fills in after the wholesaler ships (BTS often 24–72 hours, and cancelled orders
never get a code). Sillage can copy tracking into WooCommerce and email the customer if
**Notify customer on tracking** is on.

BeautyFort may sit in **Payment Hold** on their side if their portal still wants a payment
confirmation.

### Secrets

Paste **BeautyFort user**, **BeautyFort secret**, and **BTS JWT**. Status shows set vs empty
(`••••••••`). Values are **never** shown again after save.

Set these before the first **Rebuild catalogue**. Overview will nag you if they are missing.

### Settings

**Save changes** writes the form. Only fields that actually changed do work. Big red banner if
order dry-run is off.

| Section | What you are changing |
|---|---|
| **Shop URLs** | Public shop and image CDN addresses. Saving the image CDN does **not** by itself rewrite every product photo URL |
| **Pricing & catalogue** | **Price multiplier**, optional **price tiers** (cost bands), **stock threshold**, **Hide products without image** (leave **on**) |
| **Cart minimum (storefront fee)** | Optional small-order fee on the **retail** shop (off by default). Independent of per-vendor minimum order value. The **wholesale** shop instead **blocks checkout** under €300 |
| **Schedule** | **Sync enabled**, timezone, **Minutes between syncs** (a *check interval*, not “minutes a day”), **Daily full catalogue rebuild** + hour |
| **Order safety** | Dry-run, auto-dispatch, max order value, daily spend cap, tracking poll minutes, customer email on tracking |
| **Advanced** | Volume filter (ranges vs exact ml), description mode, **company billing** (fill BeautyFort **before** the first live BeautyFort order; BTS invoices from their portal) |

**Minutes between syncs** is “how often we are allowed to call” — the number you type on Settings
(30, 40, …). It is not a budget of minutes per day, and it is not hardcoded.

### Logs

Internal event trail (when / level / message). Useful if something failed and you are talking to
whoever maintains the server. You do not need it for daily markup changes.

---

## 7. What shoppers experience

These rules are on purpose. They match how dropship dispatch works.

**Basket / checkout.** Retail has no supplier minimum. The wholesale shop
(https://wholesale.mirainikki.xyz) **will not let you check out under €300** — the cart shows how
much more to add. That is a real supplier rule, not a small-order fee.

**Photos.** Listings without a real photo stay **out of the shop** while **Hide products without
image** is on. Weak BeautyFort `/pic/` thumbs count as “no photo”. Extra files sitting in the
EAN scrape folder are **not** shop photos until someone inspects them — many are tiny or generic.
Google is allowed to crawl the shop. Only products that are **visible in the shop** (real photo
+ enough stock, not **Keep hidden**) are listed in the sitemap. Catalogue-hidden products are
told not to be indexed. The sitemap is a static file Caddy serves (PHP does not build it). It
refreshes when the catalogue is fully rebuilt, not on every **Minutes between syncs** tick —
that setting is only how often wholesale **price and stock** are checked.

**Price.** What the customer pays is **your markup on wholesale cost**. Wholesaler “RRP” is ignored
(BTS recommended prices are often empty or nonsense). There is no fake “was €X, now €Y” from those
feeds.

**Cart.** A cart cannot mix BeautyFort and BTS. Adding the second vendor is blocked, with an
explanation to check out separately.

**Checkout countries.** The country list only includes places **that vendor can ship to**.
BeautyFort is a smaller EU set; BTS is broader.

**EAN.** The barcode appears on the product page. Shop search understands barcodes.

**Track order.** Customers open https://prinscosmetic.eu/track-order/ and enter order
number + checkout email.

**Vendor names.** LPS01 / LPS02 are operations labels. They must not appear as shop categories or
on the product “Additional information” table.

---

## 8. Everyday recipes

**I want selling prices 50% above cost**  
Settings → Pricing & catalogue → Price multiplier `1.5` → **Save changes** → wait for
recalculation → spot-check a product on the shop. Do **not** start a live Sync just to reprice.

**A product has stock but is missing from the shop**  
Products → search SKU → read **Shop**. **Hidden · no image** means it needs a real photo, not more
stock. **Hidden · stock** means the threshold hid it. **Hidden · pinned** means someone chose
**Keep hidden**.

**A photo on the shop is wrong or not good enough**  
Products → search SKU → **Open photo** to inspect → Shop dropdown → **Keep hidden**. Do not delete
the product in WooCommerce.

**I want to pause catalogue updates**  
Settings → turn **Sync enabled** off, or **Stop** while a run is active. Turn **Sync enabled**
back on when you want the scheduled checks again (interval = **Minutes between syncs**).

**I want to test dispatch without spending**  
Leave dry-run **on**, auto-dispatch **off**. Orders → **Dry-run**. Read the result. Do not press
**Live**.

**First real wholesaler order**  
Fill BeautyFort company billing if the line is BeautyFort. Auto-dispatch off. **Live** on **one**
row, confirm. Watch for a vendor order number. Tracking may take a day or more.

**Customer asks where the parcel is**  
Dashboard Orders → that row → Tracking, and/or the shop track-order page.

---

## 9. What this system will not do

- It will not mix two wholesalers in one shipment.
- It will not use BTS “recommended retail” as a strike-through price.
- It will not show products with only a camera icon or a tiny BeautyFort thumb while hide-without-image is on.
- It will not import wholesale-perfumes onto this retail shop.
- It will not give you a wholesaler sandbox. Live is live.
- WordPress is not the place to “fix” 50,000 prices by hand. Use Settings.

---

## 10. If something looks wrong

| Symptom | What to check |
|---|---|
| Shop prices did not change after markup Save | Wait for the rewrite toast / Sync run. If a sync was already running, the rewrite is queued |
| Sync button says **Scheduled (30m)** and will not click | That is correct while Sync enabled is on |
| BTS fetched 0 and the run is still success | Normal on most interval checks (BTS daily batch) |
| Overview **Visible in shop** is much smaller than **Published in WP** | Hidden no-image + stock hide. Expected. Check the identity line: visible + hidden = published |
| Wholesale `https://…/shop/` is Apache **Not Found** | Pretty permalinks need `wp-wholesale/.htaccess`. Bootstrap writes `ecom_sites/config/wordpress.htaccess`. Live fix: copy that file into the WordPress web root. |
| Wholesale `/shop/` loads but says “Great things are on the horizon” | WooCommerce **Coming soon** mode. Bootstrap now sets `woocommerce_coming_soon=no`. |
| Sync **Fetched** is ~140k after a prices & stock run | Old count of raw store XML lines. After this fix, Fetched is unique catalogue SKUs (~19k). A run with 0 shop writes right after a rebuild is normal |
| Red **Orders dry-run is OFF** banner | Turn dry-run back on unless you are deliberately live |
| Dashboard will not load | Tell whoever runs the server; this guide cannot fix hosting |

---

## Login reminder

| Surface | URL |
|---|---|
| Dashboard | https://sillage.prinscosmetic.eu |
| Shop | https://prinscosmetic.eu |
| Customer tracking | https://prinscosmetic.eu/track-order/ |

User for the dashboard is **admin** unless you were told otherwise. Keep the password off GitHub
and out of chat logs.
