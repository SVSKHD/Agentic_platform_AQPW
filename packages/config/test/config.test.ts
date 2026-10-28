import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

const base = {
  MONGODB_URI: "mongodb://localhost:27017/uap",
  REDIS_URL: "redis://localhost:6379",
  API_KEY_PEPPER: "x".repeat(32),
};

describe("loadConfig", () => {
  it("loads a minimal environment with optional integrations disabled", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(4000);
    expect(config.openrouter).toBeUndefined();
    expect(config.integrations).toEqual({ openrouter: false, firebase: false, aquakartMongo: false, moneyprinter: false, meta: false, s3: false });
  });

  it("fails fast on missing required variables", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (err) {
      expect((err as ConfigError).issues.join("\n")).toMatch(/MONGODB_URI/);
    }
  });

  it("rejects a short API key pepper", () => {
    expect(() => loadConfig({ ...base, API_KEY_PEPPER: "short" })).toThrow(/API_KEY_PEPPER/);
  });

  it("treats a partially configured integration as an error, not as disabled", () => {
    expect(() => loadConfig({ ...base, FIREBASE_PROJECT_ID: "p" })).toThrow(/firebase is partially configured/);
  });

  it("enables an integration only when its whole group is present", () => {
    const config = loadConfig({ ...base, FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e@p.iam", FIREBASE_PRIVATE_KEY: "line1\\nline2" });
    expect(config.integrations.firebase).toBe(true);
    expect(config.firebase?.privateKey).toBe("line1\nline2");
  });

  it("limits agent jobs to 2 attempts by default and refuses a higher limit", () => {
    expect(loadConfig(base).agents.maxAttempts).toBe(2);
    expect(loadConfig({ ...base, AGENT_MAX_ATTEMPTS: "1" }).agents.maxAttempts).toBe(1);
    expect(() => loadConfig({ ...base, AGENT_MAX_ATTEMPTS: "3" })).toThrow(/capped at 2/);
  });

  it("defaults the SEO cycle to suggestions on day 9 of a 10-day deadline", () => {
    expect(loadConfig(base).seoCycle).toEqual({ cycleDays: 10, suggestionLeadDays: 1 });
    expect(() => loadConfig({ ...base, SEO_CYCLE_DAYS: "5", SEO_SUGGESTION_LEAD_DAYS: "5" })).toThrow(/SEO_SUGGESTION_LEAD_DAYS/);
  });

  it("refuses to point the AquaKart connection at the platform database", () => {
    expect(() => loadConfig({ ...base, AQUAKART_MONGODB_URI: base.MONGODB_URI })).toThrow(/must not be the platform database/);
    expect(loadConfig({ ...base, AQUAKART_MONGODB_URI: "mongodb://aquakart-host/aquakart" }).aquakartMongo?.uri).toBe("mongodb://aquakart-host/aquakart");
  });

  it("blocks wildcard CORS and debug logging in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "*" })).toThrow(/CORS_ALLOWED_ORIGINS/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", LOG_LEVEL: "debug" })).toThrow(/LOG_LEVEL/);
    expect(loadConfig({ ...base, NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "https://a.com, https://b.com" }).corsAllowedOrigins).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});
