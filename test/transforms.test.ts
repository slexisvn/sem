import { describe, expect, test } from "vitest";
import { analyze, Catalog, compile, DiagCode, generate, mysql, parseModels, parseQuery, SemError } from "../src/index.js";
import { MODELS, run } from "./fixtures.js";

const CROSS_FACT = `
model Orders {
  table public.orders
  primary_key id
  dimension ordered_at: time = ordered_at
  measure gross : money = sum(amount)
  metric revenue = gross
  metric roas = revenue / ad_spend
}
model AdSpend {
  table public.ad_spend
  primary_key id
  dimension ordered_at: time = spent_at
  measure cost_sum : money = sum(cost)
  metric ad_spend = cost_sum
}
`;

function mysqlSql(query: string): string {
  const cat = Catalog.build(parseModels(MODELS));
  return generate(cat, analyze(cat, parseQuery(query)), mysql).sql;
}

describe("metric transforms become window functions", () => {
  test("mom growth uses LAG(x, 1) over the time grain", () => {
    const { sql } = run("show revenue, revenue.mom by ordered_at.month");
    expect(sql).toContain("WITH grid AS (");
    expect(sql).toContain(
      "(dense.revenue / NULLIF(LAG(dense.revenue, 1) OVER (ORDER BY ordered_at_month), 0) - 1) AS revenue_mom"
    );
  });

  test("yoy growth uses a grain-derived lag (12 for months)", () => {
    const { sql } = run("show revenue.yoy by ordered_at.month");
    expect(sql).toContain("LAG(dense.revenue, 12) OVER (ORDER BY ordered_at_month)");
  });

  test("rolling(30d) at month grain becomes a bounded ROWS window", () => {
    const { sql } = run("show revenue.rolling(30d) by ordered_at.month");
    expect(sql).toContain("SUM(dense.revenue) OVER (ORDER BY ordered_at_month ROWS BETWEEN 0 PRECEDING AND CURRENT ROW)");
  });

  test("rolling(7d) at day grain spans seven rows", () => {
    const { sql } = run("show revenue.rolling(7d) by ordered_at.day");
    expect(sql).toContain("ROWS BETWEEN 6 PRECEDING AND CURRENT ROW");
  });

  test("cumulative is a running total", () => {
    const { sql } = run("show revenue.cumulative by ordered_at.month");
    expect(sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
  });

  test("share of grand total uses SUM(x) OVER ()", () => {
    const { sql } = run("show revenue.share by region");
    expect(sql).toContain("(grid.revenue / NULLIF(SUM(grid.revenue) OVER (), 0)) AS revenue_share");
  });

  test("share(region) partitions the window", () => {
    const { sql } = run("show revenue.share(region) by region, status");
    expect(sql).toContain("SUM(grid.revenue) OVER (PARTITION BY region)");
  });

  test("a base metric shared by a transform is computed once in the grid", () => {
    const { sql } = run("show revenue, revenue.mom, revenue.cumulative by ordered_at.month");
    const gridCols = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM public.orders"));
    expect(gridCols.match(/AS revenue\b/g)).toHaveLength(1);
  });

  test("a transform without a time grain is a type error", () => {
    try {
      run("show revenue.mom by region");
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(SemError);
      expect((err as SemError).code).toBe(DiagCode.TypeMismatch);
    }
  });

  test("a transform over a ratio of two fact tables windows the joined grid", () => {
    const { sql } = compile(CROSS_FACT, "show roas.mom by ordered_at.month");
    expect(sql).toContain("(orders_agg.m0 / NULLIF(adspend_agg.m0, 0)) AS roas");
    expect(sql).toContain("FULL OUTER JOIN adspend_agg USING (ordered_at_month)");
    expect(sql).toContain("(dense.roas / NULLIF(LAG(dense.roas, 1) OVER (ORDER BY ordered_at_month), 0) - 1) AS roas_mom");
  });

  test("a transform on one fact leaves the other fact's metric untouched beside it", () => {
    const { sql } = compile(CROSS_FACT, "show revenue.mom, ad_spend by ordered_at.month");
    expect(sql).toContain("LAG(dense.revenue, 1)");
    expect(sql).toContain("dense.ad_spend AS ad_spend");
  });
});

describe("level-of-detail: .of re-aggregates a metric to a coarser grain", () => {
  test("of(dim) is the base subtotal broadcast across the other dimensions", () => {
    const { sql } = run("show revenue.of(region) by region, status");
    expect(sql).toContain("SUM(grid.revenue) OVER (PARTITION BY region) AS revenue_of");
  });

  test("the detail and its subtotal come back as separate columns for comparison", () => {
    const { sql } = run("show revenue, revenue.of(region) by region, status");
    expect(sql).toContain("grid.revenue AS revenue");
    expect(sql).toContain("SUM(grid.revenue) OVER (PARTITION BY region) AS revenue_of");
  });

  test("of() with no dimension is the grand total", () => {
    const { sql } = run("show revenue.of() by region, status");
    expect(sql).toContain("SUM(grid.revenue) OVER () AS revenue_of");
  });

  test("the subtotal follows the base's own re-aggregation, not always sum", () => {
    const { sql } = run("show peak.of(region) by region, status");
    expect(sql).toContain("MAX(grid.peak) OVER (PARTITION BY region) AS peak_of");
  });

  test("a non-additive base cannot form a subtotal", () => {
    expect(() => run("show avg_amount.of(region) by ordered_at.month, region")).toThrowError(SemError);
  });

  test("of() only partitions by dimensions that are in the by-list", () => {
    expect(() => run("show revenue.of(status) by region")).toThrowError(/not one of the 'by' dimensions/);
  });

  test("of() does not build a date spine because it has no series", () => {
    const { sql } = run("show revenue.of(region) by region, status");
    expect(sql).not.toContain("spine AS (");
  });
});

describe("windowed transforms partition non-time dimensions", () => {
  test("a second dimension becomes the window partition so series do not bleed together", () => {
    const { sql } = run("show revenue.mom by ordered_at.month, region");
    expect(sql).toContain("OVER (PARTITION BY region ORDER BY ordered_at_month)");
  });

  test("rolling partitions by the non-time dimensions too", () => {
    const { sql } = run("show revenue.rolling(30d) by ordered_at.month, region");
    expect(sql).toContain("PARTITION BY region ORDER BY ordered_at_month ROWS BETWEEN");
  });
});

describe("date spine densifies the time axis for gap-correct windows", () => {
  test("a spine is generated between the min and max present period", () => {
    const { sql } = run("show revenue.mom by ordered_at.month");
    expect(sql).toContain("spine AS (");
    expect(sql).toContain("generate_series((SELECT MIN(ordered_at_month) FROM grid), (SELECT MAX(ordered_at_month) FROM grid), INTERVAL '1 month')");
    expect(sql).toContain("LEFT JOIN grid ON spine.ordered_at_month = grid.ordered_at_month");
  });

  test("extra dimensions are cross joined into the spine so every series is dense", () => {
    const { sql } = run("show revenue.mom by ordered_at.month, region");
    expect(sql).toContain("CROSS JOIN (SELECT DISTINCT region FROM grid) AS combos");
    expect(sql).toContain("spine.region = grid.region");
  });

  test("a share transform without a series does not build a spine", () => {
    const { sql } = run("show revenue.share by region");
    expect(sql).not.toContain("spine AS (");
  });

  test("mysql builds its spine from a recursive cte, so a gap month still shifts the lag", () => {
    const sql = mysqlSql("show revenue.mom by ordered_at.month");
    expect(sql).toContain("WITH RECURSIVE grid AS (");
    expect(sql).toContain("SELECT (SELECT MIN(ordered_at_month) FROM grid) AS period");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("SELECT DATE_ADD(period, INTERVAL 1 MONTH) FROM spine_seq WHERE DATE_ADD(period, INTERVAL 1 MONTH) <= (SELECT MAX(ordered_at_month) FROM grid)");
    expect(sql).toContain("LAG(dense.revenue, 1) OVER");
  });

  test("the recursive keyword appears only when a dialect actually needs it", () => {
    expect(run("show revenue.mom by ordered_at.month").sql).not.toContain("RECURSIVE");
    expect(mysqlSql("show revenue.share by region")).not.toContain("RECURSIVE");
  });
});

describe("period-to-date transforms reset a running total at period boundaries", () => {
  test("mtd partitions a running sum by the enclosing month", () => {
    const { sql } = run("show revenue.mtd by ordered_at.day");
    expect(sql).toContain(
      "SUM(dense.revenue) OVER (PARTITION BY DATE_TRUNC('month', ordered_at_day) ORDER BY ordered_at_day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS revenue_mtd"
    );
  });

  test("ytd partitions by the enclosing year", () => {
    const { sql } = run("show revenue.ytd by ordered_at.month");
    expect(sql).toContain("PARTITION BY DATE_TRUNC('year', ordered_at_month)");
  });

  test("a grouping dimension is kept alongside the period bucket", () => {
    const { sql } = run("show revenue.qtd by ordered_at.day, region");
    expect(sql).toContain("PARTITION BY region, DATE_TRUNC('quarter', ordered_at_day)");
  });

  test("the grain must be finer than the period", () => {
    expect(() => run("show revenue.mtd by ordered_at.month")).toThrowError(/finer than 'month'/);
  });

  test("qtd accepts a month grain because a month is finer than a quarter", () => {
    expect(run("show revenue.qtd by ordered_at.month").sql).toContain("PARTITION BY DATE_TRUNC('quarter', ordered_at_month)");
  });

  test("ytd accepts a quarter grain", () => {
    expect(run("show revenue.ytd by ordered_at.quarter").sql).toContain("PARTITION BY DATE_TRUNC('year', ordered_at_quarter)");
  });

  test("a grain equal to the period is rejected", () => {
    expect(() => run("show revenue.qtd by ordered_at.quarter")).toThrowError(/finer than 'quarter'/);
    expect(() => run("show revenue.ytd by ordered_at.year")).toThrowError(/finer than 'year'/);
  });

  test("a non-additive base cannot run a period-to-date total", () => {
    expect(() => run("show avg_amount.ytd by ordered_at.month")).toThrowError(SemError);
  });
});
