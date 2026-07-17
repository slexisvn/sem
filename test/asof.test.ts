import { describe, expect, test } from "vitest";
import { bigquery, compile, DiagCode, mysql, SemError } from "../src/index.js";

const MODEL = (join: string): string => `
model Orders {
  table public.orders
  primary_key id
  ${join}
  dimension currency: string
  dimension ordered_at: time
  measure gross = sum(amount)
  metric revenue = gross
}
model Rates {
  table public.fx_rates
  primary_key id
  dimension currency: string
  dimension tier: string
  dimension as_of: time
}`;

const LATEST = MODEL("join Rates on currency = Rates.currency asof ordered_at >= Rates.as_of (many_to_one)");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SemError) return error.code;
    throw error;
  }
}

describe("asof join matches the most recent row of a temporal table", () => {
  test("it compiles to a lateral subquery ordered by the target timestamp", () => {
    const { sql } = compile(LATEST, "show revenue by Rates.tier");
    expect(sql).toContain(
      "LEFT JOIN LATERAL (SELECT * FROM public.fx_rates AS rates WHERE orders.currency = rates.currency AND orders.ordered_at >= rates.as_of ORDER BY rates.as_of DESC LIMIT 1) AS rates ON TRUE"
    );
    expect(sql).toContain("GROUP BY rates.tier");
  });

  test("a >= match takes the latest prior row (descending)", () => {
    expect(compile(LATEST, "show revenue by Rates.tier").sql).toContain("ORDER BY rates.as_of DESC LIMIT 1");
  });

  test("a <= match takes the earliest following row (ascending)", () => {
    const earliest = MODEL("join Rates on currency = Rates.currency asof ordered_at <= Rates.as_of (many_to_one)");
    expect(compile(earliest, "show revenue by Rates.tier").sql).toContain("ORDER BY rates.as_of ASC LIMIT 1");
  });

  test("it does not fan out, so no primary-key dedup is emitted", () => {
    expect(compile(LATEST, "show revenue by Rates.tier").sql).not.toContain("__pk");
  });

  test("an asof edge is one-directional: the reverse navigation has no path", () => {
    expect(codeOf(() => compile(LATEST, "show revenue by Orders.currency"))).toBeUndefined();
    const reverse = compile(LATEST, "show revenue by Rates.tier").sql;
    expect(reverse).toContain("LATERAL");
  });
});

describe("asof join rejects malformed declarations", () => {
  test("a fan-out cardinality is rejected", () => {
    const bad = MODEL("join Rates on currency = Rates.currency asof ordered_at >= Rates.as_of (one_to_many)");
    expect(codeOf(() => compile(bad, "show revenue by Rates.tier"))).toBe(DiagCode.InvalidDefinition);
  });

  test("an equality match operator is rejected", () => {
    const bad = MODEL("join Rates on currency = Rates.currency asof ordered_at = Rates.as_of (many_to_one)");
    expect(codeOf(() => compile(bad, "show revenue by Rates.tier"))).toBe(DiagCode.InvalidDefinition);
  });

  test("the fact timestamp must be on the left of the match", () => {
    const bad = MODEL("join Rates on currency = Rates.currency asof Rates.as_of <= ordered_at (many_to_one)");
    expect(codeOf(() => compile(bad, "show revenue by Rates.tier"))).toBe(DiagCode.InvalidDefinition);
  });
});

describe("asof join works on every dialect with lateral joins", () => {
  test("mysql emits the same lateral shape as postgres", () => {
    const { sql } = compile(LATEST, "show revenue by Rates.tier", { dialect: mysql });
    expect(sql).toContain("LEFT JOIN LATERAL (SELECT * FROM public.fx_rates AS rates");
    expect(sql).toContain("ORDER BY rates.as_of DESC LIMIT 1) AS rates ON TRUE");
  });

  test("bigquery has no lateral join, so the same pick is expressed as a correlated array subquery", () => {
    const { sql } = compile(LATEST, "show revenue by Rates.tier", { dialect: bigquery });
    expect(sql).toContain("LEFT JOIN UNNEST(ARRAY(SELECT AS STRUCT rates.* FROM public.fx_rates AS rates");
    expect(sql).toContain("ORDER BY rates.as_of DESC LIMIT 1)) AS rates");
    expect(sql).not.toContain("LATERAL");
  });

  test("bigquery keeps the left row when no quote precedes it, as a left join must", () => {
    const { sql } = compile(LATEST, "show revenue by Rates.tier", { dialect: bigquery });
    expect(sql).toContain("LEFT JOIN UNNEST(");
  });
});
