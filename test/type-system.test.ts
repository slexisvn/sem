import { describe, expect, test } from "vitest";
import { compile, DiagCode, mysql, SemError } from "../src/index.js";

const UNITS = `
model Sales {
  table public.sales
  primary_key id
  dimension region: string
  measure gross   : money = sum(amount)
  measure orders  : count = count(id)
  measure untyped = sum(fee)
  metric revenue     = gross where region = 'VN'
  metric net         = gross - gross
  metric aov         = gross / orders
  metric with_fee    = gross + untyped
  metric mismatched  = gross + orders
}
`;

const SEMI = `
model Accounts {
  table public.balances
  primary_key id
  join Entries on id = Entries.account_id (one_to_many)
  dimension region: string
  dimension snapshot_at: time
  measure balance : money semi_additive(last by snapshot_at) = sum(amount)
  measure earliest: money semi_additive(first by snapshot_at) = sum(amount)
  measure gross   : money = sum(amount)
  metric total_balance = balance
  metric opening       = earliest
  metric inflow        = gross
}
model Entries {
  table public.entries
  primary_key id
  dimension kind: string
}
`;

const ALGEBRA = `
model Sales {
  table public.sales
  primary_key id
  dimension region: string
  dimension d: time
  measure gross  : money = sum(amount)
  measure orders : count = count(id)
  measure peak   : money = max(amount)
  metric ratio     = gross / gross
  metric area      = gross * gross
  metric aov       = gross / orders
  metric scaled    = gross / 2
  metric roundtrip = (gross / orders) * orders
  metric bad_ratio = ratio + gross
  metric bad_area  = area + gross
  metric bad_aov   = aov + gross
  metric plus_one  = gross + 1
  metric ok_scaled = scaled + gross
  metric ok_round  = roundtrip + gross
  metric net       = gross - gross
  metric mixed     = gross - peak
}
`;

function unitsIn(fn: () => unknown): [string, string] {
  try {
    fn();
  } catch (error) {
    const m = (error as SemError).message.match(/units '([^']*)' and '([^']*)'/);
    if (m) return [m[1], m[2]];
  }
  throw new Error("expected a unit mismatch");
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SemError) return error.code;
    throw error;
  }
}

function sql(model: string, query: string): string {
  return compile(model, query).sql;
}

describe("unit type system", () => {
  test("same-unit subtraction keeps the unit and compiles", () => {
    expect(() => sql(UNITS, "show net by region")).not.toThrow();
  });

  test("division derives a ratio unit without error", () => {
    expect(() => sql(UNITS, "show aov by region")).not.toThrow();
  });

  test("adding mismatched units is rejected", () => {
    expect(codeOf(() => sql(UNITS, "show mismatched by region"))).toBe(DiagCode.UnitMismatch);
  });

  test("the error names both offending units", () => {
    try {
      sql(UNITS, "show mismatched by region");
      throw new Error("expected a unit mismatch");
    } catch (error) {
      expect((error as SemError).message).toContain("'money'");
      expect((error as SemError).message).toContain("'count'");
    }
  });

  test("an unannotated measure unifies with any unit (gradual typing)", () => {
    expect(() => sql(UNITS, "show with_fee by region")).not.toThrow();
  });
});

describe("unit algebra derives and cancels dimensions", () => {
  test("dividing a unit by itself cancels to dimensionless", () => {
    expect(unitsIn(() => sql(ALGEBRA, "show bad_ratio by region"))).toEqual(["dimensionless", "money"]);
  });

  test("multiplying a unit by itself raises its exponent", () => {
    expect(unitsIn(() => sql(ALGEBRA, "show bad_area by region"))).toEqual(["money^2", "money"]);
  });

  test("division records the denominator as a negative exponent", () => {
    expect(unitsIn(() => sql(ALGEBRA, "show bad_aov by region"))).toEqual(["money/count", "money"]);
  });

  test("a bare number is dimensionless, so adding one to money is rejected", () => {
    expect(unitsIn(() => sql(ALGEBRA, "show plus_one by region"))).toEqual(["money", "dimensionless"]);
  });

  test("scaling by a constant preserves the unit", () => {
    expect(() => sql(ALGEBRA, "show ok_scaled by region")).not.toThrow();
  });

  test("a unit cancelled through multiply then divide is compatible again", () => {
    expect(() => sql(ALGEBRA, "show ok_round by region")).not.toThrow();
  });
});

describe("additivity is the meet of both operands", () => {
  test("subtracting two sums stays additive and re-aggregates under a window", () => {
    const out = sql(ALGEBRA, "show net.rolling(7d) by d.day");
    expect(out).toContain("SUM(dense.net) OVER");
  });

  test("a sum minus a max is not additive and cannot be windowed", () => {
    expect(codeOf(() => sql(ALGEBRA, "show mixed.rolling(7d) by d.day"))).toBe(DiagCode.NonAdditive);
  });

  test("the same non-additive difference still computes as a plain value", () => {
    expect(() => sql(ALGEBRA, "show mixed by region")).not.toThrow();
  });
});

describe("additivity overrides", () => {
  const NON_ADDITIVE = `
model M {
  table t
  primary_key id
  dimension d: time
  measure x : number non_additive = sum(v)
  metric mx = x
}`;

  test("a non-additive base blocks rolling windows", () => {
    expect(codeOf(() => sql(NON_ADDITIVE, "show mx.rolling(7d) by d.day"))).toBe(DiagCode.NonAdditive);
  });

  test("a non-additive base blocks share", () => {
    expect(codeOf(() => sql(NON_ADDITIVE, "show mx.share by d.day"))).toBe(DiagCode.NonAdditive);
  });

  test("an unknown semi-additive rule is a parse error", () => {
    const bad = SEMI.replace("last by snapshot_at", "median by snapshot_at");
    expect(codeOf(() => sql(bad, "show total_balance by region"))).toBe(DiagCode.ParseError);
  });

  test("a semi-additive dimension must exist on the model", () => {
    const bad = SEMI.replace("last by snapshot_at", "last by missing_col");
    expect(codeOf(() => sql(bad, "show total_balance by region"))).toBe(DiagCode.UnknownDimension);
  });

  test("a non-additive aggregate cannot be declared semi-additive", () => {
    const bad = SEMI.replace("semi_additive(last by snapshot_at) = sum(amount)", "semi_additive(last by snapshot_at) = avg(amount)");
    expect(codeOf(() => sql(bad, "show total_balance by region"))).toBe(DiagCode.InvalidDefinition);
  });
});

describe("semi-additive code generation", () => {
  test("last-value reduces over a windowed max then sums across other dims", () => {
    const out = sql(SEMI, "show total_balance by region");
    expect(out).toContain("MAX(accounts.snapshot_at) OVER (PARTITION BY accounts.region)");
    expect(out).toContain("SUM(CASE WHEN accounts.__o0 = accounts.__w0 THEN accounts.__v0 END) AS total_balance");
  });

  test("the first rule reduces over a windowed min", () => {
    expect(sql(SEMI, "show opening by region")).toContain("MIN(accounts.snapshot_at) OVER (PARTITION BY accounts.region)");
  });

  test("with no grouping dimensions the window spans the whole table", () => {
    expect(sql(SEMI, "show total_balance")).toContain("OVER () AS __w0");
  });

  test("a grouping time grain partitions the window by that grain", () => {
    expect(sql(SEMI, "show total_balance by snapshot_at.month")).toContain(
      "PARTITION BY DATE_TRUNC('month', accounts.snapshot_at)"
    );
  });

  test("semi-additive and additive measures share one scan", () => {
    const out = sql(SEMI, "show total_balance, inflow by region");
    expect(out).toContain("SUM(CASE WHEN accounts.__o0 = accounts.__w0 THEN accounts.__v0 END) AS total_balance");
    expect(out).toContain("SUM(accounts.__v0) AS inflow");
  });

  test("the same shape is emitted for positional-parameter dialects", () => {
    const out = compile(SEMI, "show total_balance by region", { dialect: mysql }).sql;
    expect(out).toContain("MAX(accounts.snapshot_at) OVER (PARTITION BY accounts.region)");
  });
});

describe("quantile aggregates", () => {
  const LAT = `
model Api {
  table logs
  primary_key id
  dimension route: string
  dimension ts: time
  measure med : time = median(latency)
  measure p95 : time = percentile(latency, 95)
  measure hits: count = count(id)
  metric latency_med = med
  metric latency_p95 = p95
  metric requests = hits
}`;

  test("median compiles to an ordered-set aggregate at 0.5", () => {
    expect(sql(LAT, "show latency_med by route")).toContain("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY api.latency)");
  });

  test("percentile maps its argument to a fraction", () => {
    expect(sql(LAT, "show latency_p95 by route")).toContain("PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY api.latency)");
  });

  test("a quantile and a plain aggregate share one scan", () => {
    const out = sql(LAT, "show latency_p95, requests by route");
    expect(out).toContain("PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY api.latency)");
    expect(out).toContain("COUNT(api.id)");
  });

  test("a quantile is non-additive and blocks window transforms", () => {
    expect(codeOf(() => sql(LAT, "show latency_p95.rolling(7d) by ts.day"))).toBe(DiagCode.NonAdditive);
  });

  test("percentile requires a value between 0 and 100", () => {
    const bad = LAT.replace("percentile(latency, 95)", "percentile(latency, 150)");
    expect(codeOf(() => sql(bad, "show latency_p95 by route"))).toBe(DiagCode.TypeMismatch);
  });

  test("percentile requires its numeric parameter", () => {
    const bad = LAT.replace("percentile(latency, 95)", "percentile(latency)");
    expect(codeOf(() => sql(bad, "show latency_p95 by route"))).toBe(DiagCode.TypeMismatch);
  });

  test("a dialect without ordered quantiles reports it instead of guessing", () => {
    expect(codeOf(() => compile(LAT, "show latency_med by route", { dialect: mysql }).sql)).toBe(DiagCode.Unsupported);
  });
});

describe("semi-additive guards never emit a silently wrong reduction", () => {
  test("a fan-out grouping dimension is rejected", () => {
    expect(codeOf(() => sql(SEMI, "show total_balance by Entries.kind"))).toBe(DiagCode.Unsupported);
  });

  test("mixing with a windowed transform is rejected", () => {
    expect(codeOf(() => sql(SEMI, "show total_balance, inflow.rolling(7d) by snapshot_at.day"))).toBe(DiagCode.Unsupported);
  });
});
