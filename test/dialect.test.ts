import { describe, expect, test } from "vitest";
import { analyze, bigquery, Catalog, generate, mysql, parseModels, parseQuery, postgres, SqlDialect } from "../src/index.js";
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

  test("mysql uses question-mark placeholders and DATE_FORMAT month truncation", () => {
    const { sql, params } = generateFor("show revenue by ordered_at.month where region = 'VN'", mysql);
    expect(sql).toContain("DATE_FORMAT(orders.ordered_at, '%Y-%m-01')");
    expect(sql).toContain("CASE WHEN orders.status = ? THEN");
    expect(sql).toContain("WHERE orders.region = ?");
    expect(params).toEqual(["paid", "VN"]);
  });

  test("mysql quotes unsafe identifiers with backticks", () => {
    expect(mysql.ident("simple_name")).toBe("simple_name");
    expect(mysql.ident("Order Total")).toBe("`Order Total`");
  });

  test("qualifiedName quotes each schema-qualified segment independently", () => {
    expect(postgres.qualifiedName("public.orders")).toBe("public.orders");
    expect(postgres.qualifiedName('public.Order List')).toBe('public."Order List"');
    expect(mysql.qualifiedName("public.Order List")).toBe("public.`Order List`");
    expect(bigquery.qualifiedName("proj.data set.tbl")).toBe("proj.`data set`.tbl");
  });
});
