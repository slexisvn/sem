import { describe, expect, test } from "vitest";
import { compile, DiagCode } from "../src/index.js";

const SALES = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string = region
  dimension status: string = status
  dimension ordered_at: time = ordered_at
  measure gross : money = sum(amount)
  measure weight : kg = sum(kg)
  measure cnt = count(id)
  metric revenue = gross
  metric mass = weight
  metric orders = cnt
}
`;

const sql = (query: string, models: string = SALES) => compile(models, query).sql;

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("arithmetic written directly into show", () => {
  test("a metric divided by its own subtotal becomes a ratio against a partitioned window", () => {
    const out = sql("show revenue / revenue.of(region) as share_of_region by region, status");
    expect(out).toContain("(grid.revenue / NULLIF(SUM(grid.revenue) OVER (PARTITION BY region), 0)) AS share_of_region");
  });

  test("the subtotal and the row value read one grid column rather than aggregating twice", () => {
    const out = sql("show revenue / revenue.of(region) as pct by region, status");
    expect(out.match(/SUM\(orders\.amount\)/g)).toHaveLength(1);
  });

  test("a plain metric sits beside an inline expression over the same base", () => {
    const out = sql("show revenue, revenue / revenue.of(region) as pct by region, status");
    expect(out).toContain("grid.revenue AS revenue");
    expect(out).toContain("AS pct");
  });

  test("arithmetic with no transform anywhere stays a single grouped select", () => {
    const out = sql("show revenue / orders as aov by region");
    expect(out).toContain("(SUM(orders.amount) / NULLIF(COUNT(orders.id), 0)) AS aov");
    expect(out).not.toContain("WITH grid");
  });

  test("parentheses group an inline expression against precedence", () => {
    const out = sql("show (revenue - revenue.of(region)) / revenue.of(region) as rel by region, status");
    expect(out).toContain("((grid.revenue - SUM(grid.revenue) OVER (PARTITION BY region)) / NULLIF(SUM(grid.revenue) OVER (PARTITION BY region), 0)) AS rel");
  });

  test("multiplication binds tighter than addition, as it does everywhere else", () => {
    expect(sql("show revenue + revenue * 2 as x by region")).toContain("(SUM(orders.amount) + (SUM(orders.amount) * 2)) AS x");
  });

  test("two different transforms over one metric share the single grid column", () => {
    const out = sql("show revenue.mom / revenue.yoy as ratio by ordered_at.month");
    expect(out).toContain("LAG(dense.revenue, 1)");
    expect(out).toContain("LAG(dense.revenue, 12)");
    expect(out.match(/SUM\(orders\.amount\)/g)).toHaveLength(1);
  });

  test("an inline expression without a name is refused, because the column would have none", () => {
    expect(codeOf(() => sql("show revenue / revenue.of(region) by region, status"))).toBe(DiagCode.InvalidDefinition);
  });

  test("a named metric keeps its own name when no alias is given", () => {
    expect(sql("show revenue by region")).toContain("AS revenue");
  });

  test("an alias renames a plain metric too", () => {
    expect(sql("show revenue as takings by region")).toContain("AS takings");
  });

  test("order by follows the alias of an inline expression", () => {
    const out = sql("show revenue / revenue.of(region) as pct by region, status order by pct desc");
    expect(out).toContain("ORDER BY pct DESC");
  });
});

describe("units survive the trip through a transform", () => {
  test("adding money to kilograms is refused inline, exactly as it is in a metric body", () => {
    expect(codeOf(() => sql("show revenue + mass as bad by region"))).toBe(DiagCode.UnitMismatch);
  });

  test("a subtotal of money is still money, so it can be added to money", () => {
    expect(sql("show revenue + revenue.of(region) as ok by region")).toContain("AS ok");
  });

  test("a running total of money is still money", () => {
    expect(sql("show revenue + revenue.cumulative() as ok by region, ordered_at.month")).toContain("AS ok");
  });

  test("a share is a dimensionless fraction, so adding money to it is refused", () => {
    expect(codeOf(() => sql("show revenue + revenue.share() as bad by region"))).toBe(DiagCode.UnitMismatch);
  });

  test("a month-over-month change is a dimensionless ratio, so adding money to it is refused", () => {
    expect(codeOf(() => sql("show revenue + revenue.mom() as bad by ordered_at.month"))).toBe(DiagCode.UnitMismatch);
  });

  test("two dimensionless ratios add up fine", () => {
    expect(sql("show revenue.share() + revenue.share() as ok by region")).toContain("AS ok");
  });
});

describe("where a transform may be written", () => {
  test("a transform inside a metric body is refused and points at the show that works", () => {
    const models = `${SALES.slice(0, SALES.lastIndexOf("}"))}  metric pct = revenue / revenue.of(region)\n}`;
    expect(() => compile(models, "show pct by region")).toThrow(/belongs in a 'show'/);
  });

  test("an unknown transform names the metric it was written on", () => {
    expect(() => sql("show revenue.wat by region")).toThrow(/unknown transform '.wat' on metric 'revenue'/);
  });

  test("a qualifier that is not a model is reported as an unknown model", () => {
    expect(codeOf(() => sql("show nope.revenue by region"))).toBe(DiagCode.UnknownModel);
  });
});
