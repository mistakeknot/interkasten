import { describe, test, expect, beforeEach } from "vitest";
import { TokenResolver } from "../../src/sync/token-resolver.js";
import { ConfigSchema } from "../../src/config/schema.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    notion: {
      tokens: { work: "ntn_work_123", personal: "ntn_personal_456" },
      database_tokens: { "db-abc": "work", "db-xyz": "personal" },
      project_tokens: { "~/projects/work-app": "work" },
      ...overrides,
    },
  });
}

describe("TokenResolver", () => {
  describe("resolveAlias", () => {
    test("resolves named alias from config", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolveAlias("work")).toBe("ntn_work_123");
      expect(resolver.resolveAlias("personal")).toBe("ntn_personal_456");
    });

    test("resolves 'default' to the default token", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolveAlias("default")).toBe("ntn_default");
    });

    test("returns undefined for unknown alias", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolveAlias("nonexistent")).toBeUndefined();
    });
  });

  describe("resolveForDatabase", () => {
    test("resolves database-specific token", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolveForDatabase("db-abc")).toBe("ntn_work_123");
      expect(resolver.resolveForDatabase("db-xyz")).toBe("ntn_personal_456");
    });

    test("falls back to default for unmapped database", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolveForDatabase("db-unknown")).toBe("ntn_default");
    });

    test("falls back to default when alias resolves to nothing", () => {
      const config = makeConfig({
        database_tokens: { "db-broken": "nonexistent" },
      });
      const resolver = new TokenResolver(config, "ntn_default");
      expect(resolver.resolveForDatabase("db-broken")).toBe("ntn_default");
    });
  });

  describe("resolve (full chain)", () => {
    test("explicit alias takes priority over everything", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      // Even though db-abc maps to "work", explicit alias "personal" wins
      expect(
        resolver.resolve({ alias: "personal", databaseId: "db-abc" })
      ).toBe("ntn_personal_456");
    });

    test("database override takes priority over default", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolve({ databaseId: "db-abc" })).toBe("ntn_work_123");
    });

    test("falls through to default when no overrides match", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.resolve({ databaseId: "db-unknown" })).toBe("ntn_default");
    });

    test("returns undefined when no default and no match", () => {
      const resolver = new TokenResolver(makeConfig());
      expect(resolver.resolve({ databaseId: "db-unknown" })).toBeUndefined();
    });
  });

  describe("getClient / pool", () => {
    test("returns same client for same token", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      const c1 = resolver.getClient("ntn_work_123");
      const c2 = resolver.getClient("ntn_work_123");
      expect(c1).toBe(c2);
    });

    test("returns different clients for different tokens", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      const c1 = resolver.getClient("ntn_work_123");
      const c2 = resolver.getClient("ntn_personal_456");
      expect(c1).not.toBe(c2);
    });

    test("getDefaultClient returns null when no default token", () => {
      const resolver = new TokenResolver(makeConfig());
      expect(resolver.getDefaultClient()).toBeNull();
    });

    test("getDefaultClient returns a client when default token is set", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      const client = resolver.getDefaultClient();
      expect(client).not.toBeNull();
    });

    test("getClientFor resolves through the full chain", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      const client = resolver.getClientFor({ databaseId: "db-abc" });
      // Should be the "work" token's client
      expect(client).toBe(resolver.getClient("ntn_work_123"));
    });
  });

  describe("metadata", () => {
    test("listAliases returns configured aliases", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.listAliases()).toEqual(["work", "personal"]);
    });

    test("hasMultipleTokens returns true when tokens configured", () => {
      const resolver = new TokenResolver(makeConfig(), "ntn_default");
      expect(resolver.hasMultipleTokens()).toBe(true);
    });

    test("hasMultipleTokens returns false with no extra tokens", () => {
      const config = ConfigSchema.parse({});
      const resolver = new TokenResolver(config, "ntn_default");
      expect(resolver.hasMultipleTokens()).toBe(false);
    });
  });
});
