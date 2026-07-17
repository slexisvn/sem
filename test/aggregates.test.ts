import { describe, expect, test } from "vitest";
import { Catalog, compileWithCatalog, DiagCode, parseModels, SemError } from "../src/index.js";
import { run } from "./fixtures.js";

function failCode(query: string): DiagCode {
  try {
    run(query);
  } catch (err) {
    expect(err).toBeInstanceOf(SemError);
    return (err as SemError).code;
  }
  throw new Error(`expected '${query}' to fail`);
}

describe("distinct aggregates", () => {
  test("count(distinct x) emits COUNT(DISTINCT ...)", () => {
    const { sql } = run("show buyers by region");
    expect(sql).toContain("COUNT(DISTINCT orders.customer_id) AS buyers");
  });

  test("distinct and non-distinct counts on one fact stay separate columns", () => {
    const { sql } = run("show buyers, orders by region");
    expect(sql).toContain("COUNT(DISTINCT orders.customer_id) AS buyers");
    expect(sql).toContain("COUNT(orders.id) AS orders");
  });

  test("min does not accept distinct", () => {
    const catalog = Catalog.build(
      parseModels(`
model M {
  table public.m
  primary_key id
  dimension g: string = g
  measure bad = min(distinct amount)
}
`)
    );
    try {
      compileWithCatalog(catalog, "show bad by g");
    } catch (err) {
      expect(err).toBeInstanceOf(SemError);
      expect((err as SemError).code).toBe(DiagCode.TypeMismatch);
      return;
    }
    throw new Error("expected min(distinct) to be rejected");
  });
});

describe("additivity guards on windowed transforms", () => {
  test("rolling over an additive sum re-aggregates with SUM", () => {
    const { sql } = run("show revenue.rolling(30d) by ordered_at.month");
    expect(sql).toContain("SUM(dense.revenue) OVER");
  });

  test("rolling over a max measure re-aggregates with MAX", () => {
    const { sql } = run("show peak.rolling(30d) by ordered_at.month");
    expect(sql).toContain("MAX(dense.peak) OVER");
  });

  test("cumulative over a max measure re-aggregates with MAX", () => {
    const { sql } = run("show peak.cumulative by ordered_at.month");
    expect(sql).toContain("MAX(dense.peak) OVER (ORDER BY ordered_at_month ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)");
  });

  test("rolling over an average is rejected as non-additive", () => {
    expect(failCode("show avg_amount.rolling(30d) by ordered_at.month")).toBe(DiagCode.NonAdditive);
  });

  test("cumulative over a distinct count is rejected as non-additive", () => {
    expect(failCode("show buyers.cumulative by ordered_at.month")).toBe(DiagCode.NonAdditive);
  });

  test("cumulative over a ratio metric is rejected as non-additive", () => {
    expect(failCode("show aov.cumulative by ordered_at.month")).toBe(DiagCode.NonAdditive);
  });

  test("share requires a sum-additive base", () => {
    expect(failCode("show peak.share by region")).toBe(DiagCode.NonAdditive);
  });

  test("mom stays valid on a non-additive base because it compares period values", () => {
    const { sql } = run("show avg_amount.mom by ordered_at.month");
    expect(sql).toContain("LAG(dense.avg_amount, 1) OVER");
  });
});

describe("fan-out aggregation deduplicates fact rows by primary key", () => {
  test("sum across a one-to-many join dedupes on the fact key before summing", () => {
    const { sql } = run("show revenue by Items.sku");
    expect(sql).toContain("SELECT DISTINCT orders.id AS __pk");
    expect(sql).toContain("LEFT JOIN public.items AS items ON orders.id = items.order_id");
    expect(sql).toContain("SUM(orders.__v0) AS revenue");
    expect(sql).toContain("GROUP BY orders.sku");
  });

  test("the filtered value column is computed once per fact row inside the dedup subquery", () => {
    const { sql } = run("show revenue by Items.sku");
    expect(sql).toContain("CASE WHEN orders.status = $1 THEN orders.amount END AS __v0");
  });

  test("count dedupes the same way so orders are not double counted", () => {
    const { sql } = run("show orders by Items.sku");
    expect(sql).toContain("SELECT DISTINCT orders.id AS __pk");
    expect(sql).toContain("COUNT(orders.__v0) AS orders");
  });

  test("max is preserved through the dedup subquery", () => {
    const { sql } = run("show peak by Items.sku");
    expect(sql).toContain("MAX(orders.__v0) AS peak");
  });

  test("distinct count is preserved through the dedup subquery", () => {
    const { sql } = run("show buyers by Items.sku");
    expect(sql).toContain("COUNT(DISTINCT orders.__v0) AS buyers");
  });

  test("a ratio metric reuses shared value columns across the fan-out", () => {
    const { sql } = run("show aov by Items.sku");
    expect(sql).toContain("(SUM(orders.__v0) / NULLIF(COUNT(orders.__v1), 0)) AS aov");
  });

  test("having filters on the deduplicated total, not on the repeated rows", () => {
    const { sql, params } = run("show revenue by Items.sku having revenue > 10");
    expect(sql).toContain("SELECT DISTINCT orders.id AS __pk");
    expect(sql).toContain("HAVING SUM(orders.__v0) > $2");
    expect(params).toEqual(["paid", 10]);
  });
});
