import { describe, expect, test } from "bun:test";
import { parseEnvFile, serializeEnvFile } from "../src/config/secrets.ts";

describe("secrets overlay dotenv", () => {
  test("parseEnvFile ignores comments and blank lines", () => {
    const map = parseEnvFile(`
# comment
WHOLESALE_PERFUMES_USER=alice
WHOLESALE_PERFUMES_TOKEN="t#ken with spaces"

# trailing
`);
    expect(map.WHOLESALE_PERFUMES_USER).toBe("alice");
    expect(map.WHOLESALE_PERFUMES_TOKEN).toBe("t#ken with spaces");
  });

  test("serializeEnvFile only emits managed keys and round-trips", () => {
    const text = serializeEnvFile({
      WHOLESALE_PERFUMES_USER: "alice",
      WHOLESALE_PERFUMES_TOKEN: 'has "quotes"',
      IGNORED_KEY: "nope",
    });
    expect(text).toContain("WHOLESALE_PERFUMES_USER=alice");
    expect(text).not.toContain("IGNORED_KEY");
    const again = parseEnvFile(text);
    expect(again.WHOLESALE_PERFUMES_USER).toBe("alice");
    expect(again.WHOLESALE_PERFUMES_TOKEN).toBe('has "quotes"');
    expect(again.IGNORED_KEY).toBeUndefined();
  });

  test("serialize never embeds raw secret in a GET-shaped payload helper", () => {
    const text = serializeEnvFile({ WHOLESALE_PERFUMES_TOKEN: "super-secret-token" });
    expect(text).toContain("super-secret-token");
    expect(text).not.toMatch(/masked|••••/);
  });
});
