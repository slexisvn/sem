import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const SALES = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string = region
  dimension status: string = status
  dimension ordered_at: time = ordered_at
  measure gross : money = sum(amount)
  measure cnt = count(id)
  measure amount_max : money = max(amount)
  metric revenue = gross
  metric orders = cnt
  metric aov = revenue / orders
  metric peak = amount_max
}
materialize daily_orders as show revenue, orders, aov, peak by region, status, ordered_at.day
`;

const run = (query: string, models: string = SALES) => compile(models, query);

describe("answering a query from a pre-aggregate", () => {
  test("a sum rolled up from a finer pre-aggregate reads the pre-aggregate instead of the fact table", () => {
    const { sql, routedTo } = run("show revenue by region");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("FROM daily_orders");
    expect(sql).toContain("SUM(daily_orders.revenue)");
    expect(sql).not.toContain("public.orders");
  });

  test("a query with no dimensions at all collapses the whole pre-aggregate to one row", () => {
    const { sql, routedTo } = run("show revenue");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("SUM(daily_orders.revenue)");
    expect(sql).not.toContain("GROUP BY");
  });

  test("a max is additive enough to roll up, because the max of maxes is the max", () => {
    const { sql, routedTo } = run("show peak by region");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("MAX(daily_orders.peak)");
  });

  test("a ratio metric cannot be rolled up from a finer grain and falls back to the fact table", () => {
    const { sql, routedTo } = run("show aov by region");
    expect(routedTo).toBeUndefined();
    expect(sql).toContain("public.orders");
    expect(sql).toContain("SUM(orders.amount)");
  });

  test("a ratio metric asked for at exactly the pre-aggregate's grain is read back without re-aggregating", () => {
    const { sql, routedTo } = run("show aov by region, status, ordered_at.day");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("MAX(daily_orders.aov)");
  });

  test("a query whose dimension the pre-aggregate never grouped by falls back to the fact table", () => {
    const models = SALES.replace(", ordered_at.day", "");
    const { routedTo } = run("show revenue by ordered_at.day", models);
    expect(routedTo).toBeUndefined();
  });

  test("a metric the pre-aggregate does not store falls back to the fact table", () => {
    const { routedTo } = run("show orders, revenue by region", SALES.replace("show revenue, orders, aov, peak", "show revenue"));
    expect(routedTo).toBeUndefined();
  });
});

describe("rolling a pre-aggregate up to a coarser time grain", () => {
  test("a daily pre-aggregate answers a monthly question by truncating its own day column", () => {
    const { sql, routedTo } = run("show revenue by ordered_at.month");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("DATE_TRUNC('month', daily_orders.ordered_at_day)");
    expect(sql).toContain("SUM(daily_orders.revenue)");
  });

  test("days nest inside weeks, so a daily pre-aggregate answers a weekly question", () => {
    const { sql, routedTo } = run("show revenue by ordered_at.week");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("DATE_TRUNC('week', daily_orders.ordered_at_day)");
  });

  test("weeks do not nest inside months, so a weekly pre-aggregate cannot answer a monthly question", () => {
    const models = SALES.replace("ordered_at.day", "ordered_at.week");
    const { routedTo } = run("show revenue by ordered_at.month", models);
    expect(routedTo).toBeUndefined();
  });

  test("a monthly pre-aggregate cannot answer a daily question, because the days are already gone", () => {
    const models = SALES.replace("ordered_at.day", "ordered_at.month");
    const { routedTo } = run("show revenue by ordered_at.day", models);
    expect(routedTo).toBeUndefined();
  });

  test("asking at the pre-aggregate's own grain does not re-truncate the column", () => {
    const { sql } = run("show revenue by ordered_at.day");
    expect(sql).not.toContain("DATE_TRUNC");
    expect(sql).toContain("daily_orders.ordered_at_day AS ordered_at_day");
  });
});

describe("filters against a pre-aggregate", () => {
  test("a filter on a grouped dimension that the query does not show is applied to the pre-aggregate", () => {
    const { sql, routedTo } = run("show revenue by region where status = 'paid'");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("WHERE daily_orders.status = $1");
  });

  test("a filter on a coarser time grain truncates the pre-aggregate's day column", () => {
    const { sql, routedTo } = run("show revenue by region where ordered_at.month = '2026-01'");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("DATE_TRUNC('month', daily_orders.ordered_at_day) = $1");
  });

  test("a filter on a column the pre-aggregate never grouped by falls back to the fact table", () => {
    const models = SALES.replace("dimension status: string = status", "dimension status: string = status\n  dimension tier: string = tier").replace(
      "by region, status, ordered_at.day",
      "by region, ordered_at.day"
    );
    const { routedTo } = run("show revenue by region where tier = 'gold'", models);
    expect(routedTo).toBeUndefined();
  });
});

describe("refusing to roll up what cannot be rolled up", () => {
  const SEMI = `
model Balances {
  table public.balances
  primary_key id
  dimension account: string = account
  dimension region: string = region
  dimension snapshot_at: time = snapshot_at
  measure bal : money semi_additive(last by snapshot_at) = sum(amount)
  measure fee : money = sum(fee)
  metric balance = bal
  metric fees = fee
}
materialize daily_bal as show balance, fees by account, region, snapshot_at.day
`;

  test("a semi-additive balance is refused a roll-up and is recomputed from the fact table instead", () => {
    const { sql, routedTo } = run("show balance by region", SEMI);
    expect(routedTo).toBeUndefined();
    expect(sql).toContain("public.balances");
    expect(sql).toContain("OVER (PARTITION BY balances.region)");
  });

  test("an additive measure sitting beside a semi-additive one in the same pre-aggregate still rolls up on its own", () => {
    const { sql, routedTo } = run("show fees by region", SEMI);
    expect(routedTo).toBe("daily_bal");
    expect(sql).toContain("SUM(daily_bal.fees)");
  });

  test("asking for a semi-additive balance at the pre-aggregate's own grain needs no roll-up and is allowed", () => {
    const { routedTo } = run("show balance by account, region, snapshot_at.day", SEMI);
    expect(routedTo).toBe("daily_bal");
  });

  const FANOUT = `
model Orders {
  table public.orders
  primary_key id
  join Items on id = Items.order_id (one_to_many)
  dimension region: string = region
  measure gross = sum(amount)
  metric revenue = gross
}
model Items {
  table public.items
  primary_key id
  dimension sku: string = sku
}
materialize by_sku as show revenue by region, sku
`;

  test("a pre-aggregate built across a fan-out join repeats each order per sku, so summing it away is refused", () => {
    const { sql, routedTo } = run("show revenue by region", FANOUT);
    expect(routedTo).toBeUndefined();
    expect(sql).toContain("public.orders");
  });

  test("a fan-out pre-aggregate still answers a question at its own grain, where nothing is summed away", () => {
    const { routedTo } = run("show revenue by region, sku", FANOUT);
    expect(routedTo).toBe("by_sku");
  });
});

describe("choosing between pre-aggregates", () => {
  const TWO = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string = region
  dimension status: string = status
  dimension ordered_at: time = ordered_at
  measure gross = sum(amount)
  metric revenue = gross
}
materialize wide as show revenue by region, status, ordered_at.day
materialize narrow as show revenue by region
`;

  test("the narrowest pre-aggregate that can answer the query is the one that gets read", () => {
    expect(run("show revenue by region", TWO).routedTo).toBe("narrow");
  });

  test("a query needing a dimension the narrow pre-aggregate dropped reads the wide one", () => {
    expect(run("show revenue by region, status", TWO).routedTo).toBe("wide");
  });

});

describe("pre-aggregates that already carry a filter", () => {
  const POLICIED = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string = region
  dimension status: string = status
  measure gross = sum(amount)
  metric revenue = gross
}
policy vn_only on Orders restrict region = 'VN'
materialize vn_daily as show revenue by region, status
`;

  test("a pre-aggregate that baked in the same policy the query applies needs no filter of its own", () => {
    const { sql, routedTo } = run("show revenue by region", POLICIED);
    expect(routedTo).toBe("vn_daily");
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("SUM(vn_daily.revenue)");
  });

  test("a query filter beyond what the pre-aggregate baked in is applied as the residual", () => {
    const { sql, params } = run("show revenue by region where status = 'paid'", POLICIED);
    expect(sql).toContain("WHERE vn_daily.status = $1");
    expect(params).toEqual(["paid"]);
  });

  test("a query that opts out of the policy cannot use a pre-aggregate that baked it in", () => {
    const { sql, routedTo } = compile(POLICIED, "show revenue by region", { policies: [] });
    expect(routedTo).toBeUndefined();
    expect(sql).toContain("public.orders");
  });

  const FILTERED = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string = region
  dimension status: string = status
  measure gross = sum(amount)
  metric revenue = gross
}
materialize paid_only as show revenue by region where status = 'paid'
`;

  test("a pre-aggregate restricted to paid orders answers a question restricted the same way", () => {
    expect(run("show revenue by region where status = 'paid'", FILTERED).routedTo).toBe("paid_only");
  });

  test("a pre-aggregate restricted to paid orders cannot answer a question about all orders", () => {
    expect(run("show revenue by region", FILTERED).routedTo).toBeUndefined();
  });

  test("a pre-aggregate restricted to paid orders cannot answer a question about refunded ones", () => {
    expect(run("show revenue by region where status = 'refunded'", FILTERED).routedTo).toBeUndefined();
  });
});

describe("routing alongside the rest of the language", () => {
  test("a month-over-month transform windows over the rolled-up pre-aggregate", () => {
    const { sql, routedTo } = run("show revenue.mom() by ordered_at.month");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("FROM daily_orders");
    expect(sql).toContain("LAG(dense.revenue, 1)");
  });

  test("a having clause is evaluated against the rolled-up total", () => {
    const { sql, routedTo } = run("show revenue by region having revenue > 100");
    expect(routedTo).toBe("daily_orders");
    expect(sql).toContain("HAVING SUM(daily_orders.revenue) > $1");
  });

  test("order by and top survive the rewrite onto the pre-aggregate", () => {
    const { sql } = run("show revenue by region order by revenue desc top 5");
    expect(sql).toContain("ORDER BY revenue DESC");
    expect(sql).toContain("LIMIT 5");
  });

  test("turning routing off compiles the same query straight against the fact table", () => {
    const { sql, routedTo } = compile(SALES, "show revenue by region", { route: false });
    expect(routedTo).toBeUndefined();
    expect(sql).toContain("public.orders");
  });
});
