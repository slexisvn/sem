import { describe, expect, test } from "vitest";
import {
  catalogFromSource,
  compileAsserts,
  compileWithCatalog,
  generateDocs,
  materialize,
  materializeDecl,
  parseProgram,
  SymbolService
} from "../src/index.js";
import { GOVERNED } from "./fixtures.js";

function governedCatalog() {
  const program = parseProgram(GOVERNED);
  return { catalog: catalogFromSource(GOVERNED), program };
}

describe("phase 3 · access policies", () => {
  test("a policy is injected into WHERE as a bind-parameterized filter", () => {
    const { catalog } = governedCatalog();
    const { sql, params } = compileWithCatalog(catalog, "show revenue by region");
    expect(sql).toContain("WHERE orders.region = $2");
    expect(params).toEqual(["paid", "VN"]);
  });

  test("a policy AND-combines with a user where", () => {
    const { catalog } = governedCatalog();
    const { sql } = compileWithCatalog(catalog, "show revenue by region where status = 'paid'");
    expect(sql).toContain("WHERE (orders.region = $2 AND orders.status = $3)");
  });

  test("policies can be selectively disabled", () => {
    const { catalog } = governedCatalog();
    const { sql } = compileWithCatalog(catalog, "show revenue by region", { policies: [] });
    expect(sql).not.toContain("region = $2");
  });
});

describe("phase 3 · metric assertions", () => {
  test("an equality assert compiles to a single-value query plus its expectation", () => {
    const { catalog, program } = governedCatalog();
    const [eq] = compileAsserts(catalog, program.asserts, undefined);
    expect(eq!.metric).toBe("revenue");
    expect(eq!.sql).toContain("SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS revenue");
    expect(eq!.sql).toContain("DATE_TRUNC('month', orders.ordered_at) = $3");
    expect(eq!.expectation).toEqual({ kind: "eq", value: 1250000 });
  });

  test("a between assert carries its range", () => {
    const { catalog, program } = governedCatalog();
    const asserts = compileAsserts(catalog, program.asserts);
    expect(asserts[1]!.expectation).toEqual({ kind: "between", lo: 20, hi: 60 });
  });
});

describe("phase 3 · materialization", () => {
  test("compiles a query to a materialized view with literals inlined", () => {
    const { catalog } = governedCatalog();
    const ddl = materialize(catalog, "revenue_by_region", "show revenue by region", { policies: [] });
    expect(ddl.startsWith("CREATE MATERIALIZED VIEW revenue_by_region AS")).toBe(true);
    expect(ddl).toContain("status = 'paid'");
    expect(ddl).not.toContain("$1");
    expect(ddl.trimEnd().endsWith(";")).toBe(true);
  });

  test("parses and compiles a top-level materialize declaration", () => {
    const source = `${GOVERNED}\nmaterialize revenue_by_region as show revenue by region where status = 'paid'`;
    const program = parseProgram(source);
    const catalog = catalogFromSource(source);
    expect(program.materializes).toHaveLength(1);
    const ddl = materializeDecl(catalog, program.materializes[0]!, { policies: [] });
    expect(ddl).toContain("CREATE MATERIALIZED VIEW revenue_by_region AS");
    expect(ddl).toContain("orders.status = 'paid'");
    expect(ddl).toContain("GROUP BY orders.region");
  });
});

describe("phase 3 · docs & symbols", () => {
  test("generates markdown documentation from the model", () => {
    const { catalog } = governedCatalog();
    const docs = generateDocs(catalog);
    expect(docs).toContain("## Orders");
    expect(docs).toContain("`revenue` = sum(amount) where status = 'paid'");
    expect(docs).toContain("`Items` (one_to_many)");
  });

  test("symbol service resolves definitions, hovers, and completions", () => {
    const { catalog } = governedCatalog();
    const symbols = new SymbolService(catalog);
    expect(symbols.definitionOf("revenue")?.kind).toBe("metric");
    expect(symbols.hover("units")).toContain("count(Items.id)");
    expect(symbols.hover("revenue")).toContain("**Metric** `Orders.revenue`");
    expect(symbols.hover("region")).toContain("**Dimension** `Orders.region`");
    expect(symbols.completions("re")).toContain("revenue");
  });
});
