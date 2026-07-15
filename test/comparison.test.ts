import { describe, expect, test } from "vitest";
import { run } from "./fixtures.js";

describe("the five spec comparison queries", () => {
  test("① dashboard tile: filtered + ratio + auto-join + where + order + top", () => {
    const { sql, params } = run(
      "show revenue, aov by tier where region = 'VN' order by revenue desc top 5"
    );
    expect(sql).toBe(
      [
        "SELECT customers.tier AS tier, SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS revenue, (SUM(CASE WHEN orders.status = $2 THEN orders.amount END) / NULLIF(COUNT(orders.id), 0)) AS aov",
        "FROM public.orders AS orders",
        "LEFT JOIN public.customers AS customers ON orders.customer_id = customers.id",
        "WHERE orders.region = $3",
        "GROUP BY customers.tier",
        "ORDER BY revenue DESC",
        "LIMIT 5;"
      ].join("\n")
    );
    expect(params).toEqual(["paid", "paid", "VN"]);
  });

  test("② many cuts of one definition: derived + ratio", () => {
    const { sql, params } = run("show revenue, net_revenue, orders, aov by region");
    expect(sql).toContain(
      "(SUM(CASE WHEN orders.status = $2 THEN orders.amount END) - SUM(CASE WHEN orders.status = $3 THEN orders.amount END)) AS net_revenue"
    );
    expect(sql).toContain("COUNT(orders.id) AS orders");
    expect(sql).toContain("GROUP BY orders.region");
    expect(sql.startsWith("SELECT orders.region AS region")).toBe(true);
    expect(params).toEqual(["paid", "paid", "refunded", "paid"]);
  });

  test("③ time grain by month", () => {
    const { sql, params } = run("show revenue by ordered_at.month");
    expect(sql).toContain("DATE_TRUNC('month', orders.ordered_at) AS ordered_at_month");
    expect(sql).toContain("GROUP BY DATE_TRUNC('month', orders.ordered_at)");
    expect(params).toEqual(["paid"]);
  });

  test("④ explicit joined dimension", () => {
    const { sql, params } = run("show revenue by Customers.country order by revenue desc top 10");
    expect(sql).toContain("customers.country AS country");
    expect(sql).toContain("LEFT JOIN public.customers AS customers ON orders.customer_id = customers.id");
    expect(sql).toContain("ORDER BY revenue DESC");
    expect(sql).toContain("LIMIT 10;");
    expect(params).toEqual(["paid"]);
  });

  test("⑤ multi-fact fan-out: CTE-per-fact with FULL OUTER JOIN", () => {
    const { sql, params } = run("show revenue, ad_spend, roas by region");
    expect(sql).toBe(
      [
        "WITH orders_agg AS (",
        "  SELECT orders.region AS region, SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS m0",
        "  FROM public.orders AS orders",
        "  GROUP BY orders.region",
        "),",
        "adspend_agg AS (",
        "  SELECT adspend.region AS region, SUM(adspend.cost) AS m0",
        "  FROM public.ad_spend AS adspend",
        "  GROUP BY adspend.region",
        ")",
        "SELECT region, orders_agg.m0 AS revenue, adspend_agg.m0 AS ad_spend, (orders_agg.m0 / NULLIF(adspend_agg.m0, 0)) AS roas",
        "FROM orders_agg",
        "FULL OUTER JOIN adspend_agg USING (region);"
      ].join("\n")
    );
    expect(params).toEqual(["paid"]);
  });
});
