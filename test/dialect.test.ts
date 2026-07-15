import { describe, expect, test } from "vitest";
import { analyze, bigquery, Catalog, generate, parseModels, parseQuery, postgres, SqlDialect } from "../src/index.js";
import { MODELS } from "./fixtures.js";

function generateFor(query: string, dialect: SqlDialect = postgres) {
  const cat = Catalog.build(parseModels(MODELS));
  const plan = analyze(cat, parseQuery(query));
  return generate(cat, plan, dialect);
}

describe("SqlDialect is the seam for warehouse differences", () => {
  test("postgres uses positional $n placeholders and DATE_TRUNC(grain, expr)", () => {
    const { sql, params } = generateFor("show revenue by ordered_at.month where region = 'VN'");
    expect(sql).toContain("DATE_TRUNC('month', orders.ordered_at)");
    expect(sql).toContain("$1");
    expect(params).toEqual(["paid", "VN"]);
  });

  test("bigquery swaps placeholder and time-truncation syntax without touching the plan", () => {
    const { sql } = generateFor("show revenue by ordered_at.month", bigquery);
    expect(sql).toContain("DATE_TRUNC(orders.ordered_at, MONTH)");
    expect(sql).toContain("CASE WHEN orders.status = ? THEN");
  });
});
