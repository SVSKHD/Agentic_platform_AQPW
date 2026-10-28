import { LlmError } from "./errors.js";
import type { BudgetGuard, RequestContext } from "./types.js";

export interface BrandBudget {
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  dailyCostLimitUsd?: number | null;
  monthlyCostLimitUsd?: number | null;
}

export interface BudgetSources {
  getBudget(brandId: string): Promise<BrandBudget | null>;
  totalsSince(brandId: string, since: Date): Promise<{ totalTokens: number; costUsd: number }>;
}

// Windows are UTC calendar day/month. Documented in docs/architecture.md.
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Enforces per-brand budgets before a call is made. A brand with no limits set is unlimited.
 * Checks are pre-call, so one in-flight request can overshoot a limit by its own size.
 */
export const createBudgetGuard = (sources: BudgetSources, now: () => Date = () => new Date()): BudgetGuard => ({
  async check({ brandId }: RequestContext) {
    const budget = await sources.getBudget(brandId);
    if (!budget) return;
    const current = now();
    const windows = [
      { since: startOfUtcDay(current), tokens: budget.dailyTokenLimit, cost: budget.dailyCostLimitUsd, label: "daily" },
      { since: startOfUtcMonth(current), tokens: budget.monthlyTokenLimit, cost: budget.monthlyCostLimitUsd, label: "monthly" },
    ];
    for (const window of windows) {
      if (window.tokens == null && window.cost == null) continue;
      const totals = await sources.totalsSince(brandId, window.since);
      if (window.tokens != null && totals.totalTokens >= window.tokens) {
        throw new LlmError("budget_exceeded", `Brand ${window.label} token budget exhausted`);
      }
      if (window.cost != null && totals.costUsd >= window.cost) {
        throw new LlmError("budget_exceeded", `Brand ${window.label} cost budget exhausted`);
      }
    }
  },
});
