# Crawler shield — copy this onto every client VPS

A 50k-product WooCommerce shop on a ~4 GB box will melt if an AI training crawler
walks every `/product/…` and `/brand/…` page. That happened on the live shop
(`prinscosmetic.eu`) on 2026-08-31. The shop is Apache prefork + PHP: each hit is a
full WordPress render. `ecom` sat at **150–163% CPU**, Valkey and MariaDB followed.

This is **not** a break-in. Nothing was stolen, no admin login, no orders placed.
It is Anthropic’s official **ClaudeBot** collecting public HTML for model training.
The damage is collateral: the crawler is polite enough to send a real User-Agent,
and not polite enough for prefork PHP.

**Same setup on a client VPS:** host Caddy in front of the shop, this `@heavybot`
block on the **shop** host only, images CDN left open. `deploy-vps.sh` writes it
automatically. On an already-running host, paste the snippet below and reload Caddy.

Deep recipe: [`VPS-DEPLOY.md`](VPS-DEPLOY.md). Domain moves: [`DOMAIN-MIGRATION.md`](DOMAIN-MIGRATION.md).

---

## What we put on the edge

Live file: `/etc/caddy/Caddyfile` (host Caddy, **not** inside `~/sillage`).

Canonical snippet in git:
[`production-environment/ecom_sites/config/caddy-heavybot.snippet`](../production-environment/ecom_sites/config/caddy-heavybot.snippet)

Shop site only (retail **and** wholesale shop hosts — not the dashboard, not the image CDN):

```caddy
@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
handle @heavybot {
	respond "Forbidden" 403
}
```

That matcher runs **before** `reverse_proxy localhost:104`. Caddy answers 403. Apache
and PHP never start. Product JPEGs on `images.*` stay open — those are cheap static
files and were not the problem.

Also blocked (same class of crawler, same failure mode if they show up):

| Token | Who | Typical job |
|---|---|---|
| `ClaudeBot` | Anthropic | Training data for Claude |
| `GPTBot` | OpenAI | Training data for GPT |
| `CCBot` | Common Crawl | Public web corpus (feeds many AI labs) |
| `Bytespider` | ByteDance | Training / index |
| `Amazonbot` | Amazon | Product / site crawl |
| `meta-externalagent` | Meta | Training / index |

Dashboard (`sillage.*`) and image CDN are **not** in this list. Do not 403 the
image host unless you have a reason.

---

## Apply on a client VPS

### New host (automatic)

`./production-environment/scripts/deploy-vps.sh` writes the shop block into
`/etc/caddy/Caddyfile`. No extra step.

**Caveat:** that script **replaces** the whole Caddyfile. Re-add any old-domain
`redir` blocks after a deploy (live still has `*.slilverbelt.xyz` → new hosts).

### Already-running host (2 minutes)

1. `sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)`
2. Inside the **shop** `{ … }` block, add the `@heavybot` handle as the **first**
   handler (before `reverse_proxy`).
3. Validate and reload — do not skip validate:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

4. Check:

```bash
# crawler — must be 403
curl -sI -A "Mozilla/5.0 AppleWebKit/537.36 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" \
  https://SHOP.example/ | head -n 5

# real browser — must still be 200
curl -sI -A "Mozilla/5.0" https://SHOP.example/ | head -n 5
```

CPU should drop within a minute (`docker stats ecom ecom-db valkey`). Leftover
MariaDB queries can take a few more minutes to drain.

### Optional: robots.txt

Anthropic’s official opt-out is `robots.txt` (`User-agent: ClaudeBot` / `Disallow: /`).
They say they honour it. We still 403 at Caddy because:

- relief has to be **immediate** (robots.txt does not stop in-flight workers)
- a 50k-SKU Woo page is too expensive even at a polite crawl-delay
- the same pattern will return with GPTBot / CCBot / Bytespider

A `robots.txt` in WordPress is a useful extra signal; it is **not** a substitute
for the Caddy block on this stack.

---

## How we knew it was ClaudeBot

Three things, together. Any one of them can be spoofed; all three matching is enough.

### 1. User-Agent

Apache `access.log` inside `ecom` showed:

```
ClaudeBot/1.0
```

That is Anthropic’s published training-crawler token. They also run
`Claude-User` (a person asked Claude to fetch a page) and `Claude-SearchBot`
(search index). Those are different jobs. We saw **ClaudeBot**.

Official write-up:
[Anthropic Help Center — web crawlers](https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)

### 2. Source IP on Anthropic’s published list

The busy client was **`216.73.217.16`**.

Anthropic publishes crawler prefixes at
[`https://claude.com/crawling/bots.json`](https://claude.com/crawling/bots.json).
That feed includes **`216.73.216.0/22`**, which covers `216.73.216.0`–`216.73.219.255`.
`216.73.217.16` sits in that range.

So this was not a random VPS pretending to be ClaudeBot. It was Anthropic’s
own crawler infrastructure.

### 3. What it did

It did not hit `wp-login.php`, `xmlrpc.php`, `/wp-admin`, or checkout. It walked
public catalogue URLs as fast as Apache would answer:

- `/?p=<id>` (Woo’s raw post permalinks)
- `/product/<slug>/`
- `/brand/<slug>/`

That is a full-site HTML harvest: title, description, price, brand, category.
Exactly what a training crawler wants. Exactly what prefork PHP cannot survive.

Restarting `ecom` only dropped the workers. The same IP + UA came back within a
minute. That ruled out a stuck Sillage rewrite, leftover scrape, or bad object
cache.

---

## Country / who / what they were using

| Question | Answer |
|---|---|
| Who | **Anthropic, PBC** (Claude). US company, San Francisco. |
| Country | Traffic came from Anthropic’s **published US crawler prefix** (`216.73.216.0/22`), hosted on their cloud egress — not a person in a basement and not a competing shop. |
| Tool | Automated HTTP GET. Browser-shaped User-Agent plus `ClaudeBot/1.0`. No exploit, no login, no POST to checkout. |
| Goal | Collect **public product HTML** so future Claude models can answer questions about brands, products, and prices more accurately. Anthropic’s own words: *“collecting web content that could potentially contribute to their training.”* |
| What they get if we allow it | Product names, descriptions, prices, brand pages — the same text a shopper sees. They do **not** get vendor costs, dashboard data, or order APIs (those are not on the public shop). |
| What we lose if we allow it | The shop. On this hardware one crawler ≈ 150 PHP workers ≈ MariaDB + Valkey storm ≈ no room left for real customers. |

This is legal crawling of a public site. It is still unacceptable on a 4 GB
Woo box. Blocking ClaudeBot at the edge tells Anthropic to keep future material
out of training sets (their documented meaning of a block) **and** keeps the
shop up.

---

## Diagnose this again in five minutes

If `ecom` CPU is high and `sillage-cron` is idle, it is almost never “the sync”:

```bash
docker stats --no-stream ecom ecom-db valkey sillage-core sillage-cron
docker top ecom          # pile of apache2 = PHP rendering pages
docker exec ecom tail -n 50 /var/log/apache2/access.log
```

Group the last few minutes by IP and by User-Agent. One IP + an AI UA +
`/product/` or `/?p=` is this class of incident.

Caddy 403s land in `journalctl -u caddy`, not in Apache — once the shield is
on, Apache should go quiet.

Do **not** kill `mariadbd` to “fix CPU”. Do **not** `FLUSHDB` on Valkey during
the day (that causes a shop stampede of its own).

---

## Structural follow-up (optional, not required to copy the live fix)

The shield is the cheap, correct first step. The box will still spike if a
crawler we have not listed yet arrives, or if someone flushes object cache.

Later, if a client VPS has the RAM:

- Apache **event** MPM + **php-fpm** (one worker does not equal one PHP process)
- A real page cache in front of Woo for anonymous GET

Neither is required to match what is live today.
