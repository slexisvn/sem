import { describe, expect, test } from "vitest";
import { Catalog, compileWithCatalog, DiagCode, parseModels, SemError } from "../src/index.js";

function compileError(models: string, query: string): SemError {
  try {
    compileWithCatalog(Catalog.build(parseModels(models)), query);
  } catch (err) {
    if (err instanceof SemError) return err;
    throw err;
  }
  throw new Error("expected a SemError");
}

const BASE = `
model Orders {
  table public.orders
  primary_key id
  join Items on id = Items.order_id (one_to_many)
  dimension region: string = region
  dimension status: string = status
  measure gross = sum(amount)
  measure cnt = count(id)
  metric revenue = gross where status = 'paid'
  metric orders = cnt
  metric aov = revenue / orders
}
model Items {
  table public.items
  primary_key id
  dimension sku: string = sku
  measure qty_sum = sum(qty)
}
`;

function model(body: string): string {
  return `model M { table public.m primary_key id dimension g: string = g ${body} }`;
}

describe("measure is a pure aggregate primitive", () => {
  test("a simple metric wrapping a measure with a filter compiles to a filtered aggregate", () => {
    const { sql } = compileWithCatalog(Catalog.build(parseModels(BASE)), "show revenue by region");
    expect(sql).toContain("SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS revenue");
  });

  test("a measure cannot reference another measure or metric", () => {
    expect(compileError(model("measure a = sum(x) metric b = a measure c = b"), "show c by g").code).toBe(
      DiagCode.InvalidDefinition
    );
  });

  test("a measure must be a single aggregate, not a composition", () => {
    expect(compileError(model("measure a = sum(x) + sum(y)"), "show a by g").code).toBe(DiagCode.InvalidDefinition);
  });

  test("a measure must aggregate its own model's columns", () => {
    const cross = `
      model A { table public.a primary_key id join B on b_id = B.id (many_to_one) measure bad = sum(B.v) }
      model B { table public.b primary_key id }
    `;
    expect(compileError(cross, "show bad").code).toBe(DiagCode.InvalidDefinition);
  });
});

describe("metric is a composite built from measures", () => {
  test("a metric cannot call an aggregate directly", () => {
    expect(compileError(model("metric bad = sum(x)"), "show bad by g").code).toBe(DiagCode.InvalidDefinition);
  });

  test("a metric must build on at least one measure", () => {
    expect(compileError(model("metric bad = 5"), "show bad by g").code).toBe(DiagCode.InvalidDefinition);
  });

  test("ratio and derived metrics compose measures across the model", () => {
    const { sql } = compileWithCatalog(Catalog.build(parseModels(BASE)), "show aov by region");
    expect(sql).toContain("/ NULLIF(");
  });
});
