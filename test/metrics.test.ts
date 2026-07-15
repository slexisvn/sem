import { describe, expect, test } from "vitest";
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

    const likeQuery = run("show revenue where region like 'V%'");
    expect(likeQuery.sql).toContain("orders.region LIKE $2");
    expect(likeQuery.params).toEqual(["paid", "V%"]);
  });
});
