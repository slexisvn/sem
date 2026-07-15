import { describe, expect, test } from "vitest";
import { analyze, Catalog, DiagCode, generate, mysql, parseModels, parseQuery, SemError } from "../src/index.js";
import { MODELS, run } from "./fixtures.js";

function mysqlSql(query: string): string {
  const cat = Catalog.build(parseModels(MODELS));
  return generate(cat, analyze(cat, parseQuery(query)), mysql).sql;
}

describe("phase 2 metric transforms → window functions", () => {
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

  test("transforms across two fact tables are refused", () => {
    try {
      run("show roas.mom by region");
      throw new Error("expected failure");
    } catch (err) {
      expect((err as SemError).code).toBe(DiagCode.Unsupported);
    }
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

  test("dialects without a period series fall back to the positional grid", () => {
    const sql = mysqlSql("show revenue.mom by ordered_at.month");
    expect(sql).not.toContain("spine AS (");
    expect(sql).toContain("LAG(grid.revenue, 1) OVER");
  });
});
