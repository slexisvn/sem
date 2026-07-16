import { describe, expect, test } from "vitest";
import { bigquery, compile, DiagCode, mysql, SemError } from "../src/index.js";

const model = (extra: string) => `
model Orders {
  table public.orders
  primary_key id
${extra}
  dimension region: string = region
  dimension ordered_at: time = ordered_at
  measure gross = sum(amount)
  metric revenue = gross
  metric aov = gross / gross
}
`;

const APRIL = model("  fiscal_year_starts 4");
const JANUARY = model("  fiscal_year_starts 1");

describe("grouping by a fiscal period", () => {
  test("a fiscal year shifts the calendar back, cuts the year, then shifts forward to the year's opening month", () => {
    const { sql } = compile(APRIL, "show revenue by ordered_at.fiscal_year");
    expect(sql).toContain("(DATE_TRUNC('year', (orders.ordered_at - INTERVAL '3 months')) + INTERVAL '3 months')");
  });

  test("a fiscal quarter cuts on quarter boundaries of the same shifted calendar", () => {
    const { sql } = compile(APRIL, "show revenue by ordered_at.fiscal_quarter");
    expect(sql).toContain("(DATE_TRUNC('quarter', (orders.ordered_at - INTERVAL '3 months')) + INTERVAL '3 months')");
  });

  test("a fiscal year opening in january is the calendar year, so nothing is shifted at all", () => {
    const { sql } = compile(JANUARY, "show revenue by ordered_at.fiscal_year");
    expect(sql).toContain("DATE_TRUNC('year', orders.ordered_at)");
    expect(sql).not.toContain("INTERVAL");
  });

  test("declaring a fiscal year leaves the calendar grains exactly where they were", () => {
    const { sql } = compile(APRIL, "show revenue by ordered_at.year");
    expect(sql).toContain("DATE_TRUNC('year', orders.ordered_at)");
    expect(sql).not.toContain("INTERVAL");
  });

  test("a filter on a fiscal period buckets the same way the grouping does", () => {
    const { sql } = compile(APRIL, "show revenue by region where ordered_at.fiscal_year = '2026-04-01'");
    expect(sql).toContain("WHERE (DATE_TRUNC('year', (orders.ordered_at - INTERVAL '3 months')) + INTERVAL '3 months') = $1");
  });

  test("a timezone and a fiscal year compose: the instant is made local before the year is cut", () => {
    const { sql } = compile(model("  timezone 'Asia/Ho_Chi_Minh'\n  fiscal_year_starts 4"), "show revenue by ordered_at.fiscal_year");
    expect(sql).toContain(
      "(DATE_TRUNC('year', ((orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh') - INTERVAL '3 months')) + INTERVAL '3 months')"
    );
  });

  test("retention cohorts can be counted in fiscal years", () => {
    const { sql } = compile(APRIL, "retention Orders by id over ordered_at.fiscal_year periods 2");
    expect(sql).toContain("(DATE_TRUNC('year', (orders.ordered_at - INTERVAL '3 months')) + INTERVAL '3 months')");
    expect(sql).toContain("EXTRACT(YEAR FROM e.__p) - EXTRACT(YEAR FROM c.__c)");
  });

  test("a dense spine over fiscal quarters steps three months at a time", () => {
    const { sql } = compile(APRIL, "show revenue.cumulative() by ordered_at.fiscal_quarter");
    expect(sql).toContain("INTERVAL '3 months'");
  });
});

describe("fiscal periods per dialect", () => {
  test("bigquery shifts with its own date arithmetic", () => {
    const { sql } = compile(APRIL, "show revenue by ordered_at.fiscal_year", { dialect: bigquery });
    expect(sql).toContain("DATE_ADD(DATE_TRUNC(DATE_SUB(orders.ordered_at, INTERVAL 3 MONTH), YEAR), INTERVAL 3 MONTH)");
  });

  test("bigquery uses datetime arithmetic once a zone is in play, because its timestamps cannot step by months", () => {
    const { sql } = compile(model("  timezone 'Asia/Ho_Chi_Minh'\n  fiscal_year_starts 4"), "show revenue by ordered_at.fiscal_year", {
      dialect: bigquery
    });
    expect(sql).toContain("DATETIME_SUB(DATETIME(orders.ordered_at, 'Asia/Ho_Chi_Minh'), INTERVAL 3 MONTH)");
    expect(sql).not.toContain("TIMESTAMP_ADD");
  });

  test("mysql wraps its own month formatting in the same shift", () => {
    const { sql } = compile(APRIL, "show revenue by ordered_at.fiscal_year", { dialect: mysql });
    expect(sql).toContain("DATE_ADD(DATE_FORMAT(DATE_SUB(orders.ordered_at, INTERVAL 3 MONTH), '%Y-01-01'), INTERVAL 3 MONTH)");
  });
});

describe("rejecting fiscal years that cannot mean anything", () => {
  test("the opening month must be a real month", () => {
    for (const month of [0, 13, 4.5]) {
      expect(() => compile(model(`  fiscal_year_starts ${month}`), "show revenue by ordered_at.fiscal_year")).toThrow(SemError);
    }
  });

  test("the error names the range rather than leaving the reader guessing", () => {
    try {
      compile(model("  fiscal_year_starts 13"), "show revenue by ordered_at.fiscal_year");
      expect.unreachable();
    } catch (error) {
      expect((error as SemError).code).toBe(DiagCode.InvalidDefinition);
      expect((error as SemError).message).toMatch(/from 1 to 12/);
    }
  });
});

describe("which grains a period-to-date window may run over", () => {
  test("a fiscal quarter can straddle a calendar year, so a year-to-date running total over it is refused", () => {
    expect(() => compile(APRIL, "show revenue.ytd() by ordered_at.fiscal_quarter")).toThrow(/does not/);
  });

  test("a week can straddle a month, so a month-to-date running total over weeks is refused", () => {
    expect(() => compile(APRIL, "show revenue.mtd() by ordered_at.week")).toThrow(/does not/);
  });

  test("days nest inside months, so a month-to-date running total over days is allowed", () => {
    expect(compile(APRIL, "show revenue.mtd() by ordered_at.day").sql).toContain("PARTITION BY DATE_TRUNC('month', ordered_at_day)");
  });
});

describe("pre-aggregates over fiscal periods", () => {
  const MV = `${APRIL}
materialize daily as show revenue by region, ordered_at.day
`;

  test("a daily pre-aggregate rolls up into fiscal years, because days nest inside them", () => {
    const { sql, routedTo } = compile(MV, "show revenue by ordered_at.fiscal_year");
    expect(routedTo).toBe("daily");
    expect(sql).toContain("SUM(daily.revenue)");
    expect(sql).toContain("(DATE_TRUNC('year', (daily.ordered_at_day - INTERVAL '3 months')) + INTERVAL '3 months')");
  });

  test("a pre-aggregate cut on calendar quarters cannot answer a fiscal-quarter question", () => {
    const calendar = MV.replace("ordered_at.day", "ordered_at.quarter");
    expect(compile(calendar, "show revenue by ordered_at.fiscal_quarter").routedTo).toBeUndefined();
  });

  test("a pre-aggregate cut on fiscal quarters rolls up into fiscal years", () => {
    const fiscal = MV.replace("ordered_at.day", "ordered_at.fiscal_quarter");
    expect(compile(fiscal, "show revenue by ordered_at.fiscal_year").routedTo).toBe("daily");
  });

  test("a pre-aggregate cut on fiscal quarters cannot answer a calendar-year question", () => {
    const fiscal = MV.replace("ordered_at.day", "ordered_at.fiscal_quarter");
    expect(compile(fiscal, "show revenue by ordered_at.year").routedTo).toBeUndefined();
  });
});
