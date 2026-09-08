/**
 * German transliterations WordPress's `remove_accents()` applies for a de_DE locale. These must
 * run before generic diacritic stripping, otherwise "ö" becomes "o" rather than "oe" and the slug
 * stops matching what WordPress itself would have produced.
 */
const GERMAN: Array<[RegExp, string]> = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/Ä/g, "Ae"],
  [/Ö/g, "Oe"],
  [/Ü/g, "Ue"],
  [/ß/g, "ss"],
];

const EXTRA: Array<[RegExp, string]> = [
  [/æ/gi, "ae"],
  [/œ/gi, "oe"],
  [/ø/gi, "o"],
  [/Ø/g, "O"],
  [/đ/gi, "d"],
  [/ð/gi, "d"],
  [/þ/gi, "th"],
  [/ł/gi, "l"],
  [/&/g, " and "],
];

/**
 * Approximates WordPress's `sanitize_title()` closely enough that terms created here look native.
 * We reimplement it because the bulk writer never boots WordPress.
 */
export function slugify(input: string, maxLength = 190): string {
  let s = String(input ?? "");

  for (const [pattern, replacement] of GERMAN) s = s.replace(pattern, replacement);
  for (const [pattern, replacement] of EXTRA) s = s.replace(pattern, replacement);

  s = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip remaining combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (s.length > maxLength) {
    s = s.slice(0, maxLength).replace(/-[^-]*$/, "").replace(/-$/, "");
  }
  return s;
}

/**
 * Product slugs are deterministic and unique by construction: the SKU is already unique, so
 * appending it removes any need for a check-then-suffix round trip against `wp_posts`, and makes
 * re-runs produce byte-identical slugs.
 *
 * `wp_posts.post_name` is VARCHAR(200); the name is truncated to leave room for the suffix.
 */
export function productSlug(name: string, sku: string): string {
  const suffix = slugify(sku, 40);
  const base = slugify(name, Math.max(20, 195 - suffix.length - 1));
  return base ? `${base}-${suffix}` : suffix;
}

/**
 * Fold a term name to the identity MariaDB's `utf8mb4_unicode_ci` collation actually uses.
 *
 * The term maps are keyed by this rather than by `toLowerCase()`, because the collation considers
 * "MARLIES MOLLER" = "Marlies Möller", "DSQUARED2" = "DSQUARED²" and "FERRÉ" = "FERRE". Keying by
 * the raw lowercase string made JavaScript disagree with the database: the upsert collapsed each
 * pair onto one row while the in-memory map kept asking for the other, so those terms were
 * recreated on every single run.
 *
 * Folding is also the better storefront outcome — these really are the same brand, and merging
 * them avoids two half-populated brand archives.
 *
 * Note this is deliberately *not* `slugify`, whose German transliteration maps "ö" to "oe" and
 * would therefore keep "moller" and "möller" apart.
 */
export function foldKey(input: string): string {
  return String(input ?? "")
    // NFKD also decomposes compatibility characters, so "²" becomes "2".
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Term slugs cannot use that trick — there is no unique key to append — so callers pass a set of
 * slugs already taken and this appends `-2`, `-3`, ... the way `wp_insert_term()` does.
 */
export function uniqueTermSlug(name: string, taken: Set<string>, fallback = "term"): string {
  const base = slugify(name, 190) || fallback;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base.slice(0, 190 - String(i).length - 1)}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not find a free slug for "${name}"`);
}
