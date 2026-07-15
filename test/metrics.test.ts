import { describe, expect, test } from "vitest";
import { catalogFromSource, compileWithCatalog } from "../src/index.js";
import { run } from "./fixtures.js";

describe("the four metric kinds", () => {
  test("aggregate metric compiles to a plain aggregate", () => {
    const { sql, params } = run("show orders");
    expect(sql).toContain("COUNT(orders.id) AS orders");
    expect(params).toEqual([]);
  });

  test("filtered metric compiles to CASE WHEN and parameterizes the literal", () => {
    const { sql, params } = run("show revenue");
    expect(sql).toContain("SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS revenue");
    expect(sql).not.toContain("'paid'");
    expect(params).toEqual(["paid"]);
  });

  test("derived metric expands both operands and subtracts", () => {
    const { sql } = run("show net_revenue");
    expect(sql).toContain(
      "(SUM(CASE WHEN orders.status = $1 THEN orders.amount END) - SUM(CASE WHEN orders.status = $2 THEN orders.amount END)) AS net_revenue"
    );
  });

  test("ratio metric wraps the denominator in NULLIF", () => {
    const { sql } = run("show aov");
    expect(sql).toContain("/ NULLIF(COUNT(orders.id), 0)");
  });

  test("having filters on a metric value with a bind placeholder", () => {
    const { sql, params } = run("show revenue by region having revenue > 1000");
    expect(sql).toContain("HAVING SUM(CASE WHEN orders.status = $2 THEN orders.amount END) > $3");
    expect(params).toEqual(["paid", "paid", 1000]);
  });

  test("filter predicates support in / between / like", () => {
    const inQuery = run("show revenue where status in ('paid', 'refunded')");
    expect(inQuery.sql).toContain("orders.status IN ($2, $3)");
    expect(inQuery.params).toEqual(["paid", "paid", "refunded"]);

    const betweenQuery = run("show revenue where ordered_at.month between '2026-01' and '2026-03'");
    expect(betweenQuery.sql).toContain("DATE_TRUNC('month', orders.ordered_at) BETWEEN $2 AND $3");
    expect(betweenQuery.params).toEqual(["paid", "2026-01", "2026-03"]);

    const likeQuery = run("show revenue where region like 'V%'");
    expect(likeQuery.sql).toContain("orders.region LIKE $2");
    expect(likeQuery.params).toEqual(["paid", "V%"]);
  });

  test("boolean predicates preserve grouping and negation", () => {
    const { sql, params } = run("show revenue where not (region = 'VN' or status = 'refunded')");
    expect(sql).toContain("WHERE (NOT (orders.region = $2 OR orders.status = $3))");
    expect(params).toEqual(["paid", "VN", "refunded"]);
  });

  test("aggregate arguments can be arithmetic expressions", () => {
    const catalog = catalogFromSource(`
      model Orders {
        table public.orders
        primary_key id
        metric weighted = sum(amount * qty)
      }
    `);
    const { sql } = compileWithCatalog(catalog, "show weighted");
    expect(sql).toContain("SUM((orders.amount * orders.qty)) AS weighted");
  });

  test("order by must reference a selected metric", () => {
    expect(() => run("show revenue by region order by refunds desc")).toThrow(
      "'order by' refers to 'refunds', which is not one of the shown metrics"
    );
  });

  test("having supports between on a metric expression", () => {
    const { sql, params } = run("show revenue by region having revenue between 100 and 200");
    expect(sql).toContain("HAVING SUM(CASE WHEN orders.status = $2 THEN orders.amount END) BETWEEN $3 AND $4");
    expect(params).toEqual(["paid", "paid", 100, 200]);
  });
});
