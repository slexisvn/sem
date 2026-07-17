import { describe, expect, test } from "vitest";
import { catalogFromSource, compileWithCatalog } from "../src/index.js";
import { CHAIN, GOVERNED } from "./fixtures.js";

describe("join resolution walks the model graph", () => {
  test("multi-hop join path: LineItems → Orders → Customers", () => {
    const { sql } = compileWithCatalog(catalogFromSource(CHAIN), "show units by Customers.country");
    expect(sql).toContain("FROM public.line_items AS lineitems");
    expect(sql).toContain("LEFT JOIN public.orders AS orders ON lineitems.order_id = orders.id");
    expect(sql).toContain("LEFT JOIN public.customers AS customers ON orders.customer_id = customers.id");
    expect(sql).toContain("GROUP BY customers.country");
  });

  test("bare dimension auto-joins across a single hop", () => {
    const { sql } = compileWithCatalog(catalogFromSource(CHAIN), "show units by status");
    expect(sql).toContain("LEFT JOIN public.orders AS orders ON lineitems.order_id = orders.id");
    expect(sql).toContain("GROUP BY orders.status");
  });

  test("one-to-many child metric aggregates the child, joining up to the parent dimension", () => {
    const { sql } = compileWithCatalog(catalogFromSource(GOVERNED), "show units by region", { policies: [] });
    expect(sql).toContain("COUNT(items.id) AS units");
    expect(sql).toContain("FROM public.items AS items");
    expect(sql).toContain("LEFT JOIN public.orders AS orders ON items.order_id = orders.id");
    expect(sql).toContain("GROUP BY orders.region");
  });
});
