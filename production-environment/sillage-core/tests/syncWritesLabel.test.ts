import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Sync runs table — shop write labels", () => {
  const syncSrc = readFileSync(join(import.meta.dir, "../web/src/pages/Sync.tsx"), "utf8");

  test("uses New / Updated / Prices instead of + ~ $ glyphs", () => {
    expect(syncSrc).toContain("function writesLabel");
    expect(syncSrc).toContain("`New ${");
    expect(syncSrc).toContain("`Updated ${");
    expect(syncSrc).toContain("`Prices ${");
    expect(syncSrc).toContain("Shop writes");
    expect(syncSrc).not.toContain("+{r.posts_created}");
    expect(syncSrc).not.toContain("~{r.posts_updated}");
    expect(syncSrc).not.toContain("$ {r.prices_updated}");
  });
});
