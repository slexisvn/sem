import { describe, expect, test } from "vitest";
import { bigquery, compile, DiagCode, mysql, SemError } from "../src/index.js";

const LOCAL = `
model Orders {
  table public.orders
  primary_key id
  timezone 'Asia/Ho_Chi_Minh'
  dimension region: string = region
  dimension ordered_at: time = ordered_at
  measure gross = sum(amount)
  metric revenue = gross
}
`;

const UTC = LOCAL.replace("  timezone 'Asia/Ho_Chi_Minh'\n", "");

describe("bucketing time in the model's own timezone", () => {
  test("a model without a timezone buckets on the database's own calendar, as it always did", () => {
    const { sql } = compile(UTC, "show revenue by ordered_at.month");
    expect(sql).toContain("DATE_TRUNC('month', orders.ordered_at)");
    expect(sql).not.toContain("AT TIME ZONE");
  });

  test("a declared timezone shifts the timestamp before the month boundary is decided", () => {
    const { sql } = compile(LOCAL, "show revenue by ordered_at.month");
    expect(sql).toContain("DATE_TRUNC('month', (orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh'))");
  });

  test("a filter on a time grain buckets in the same zone as the grouping, so the two agree", () => {
    const { sql } = compile(LOCAL, "show revenue by region where ordered_at.month = '2026-01'");
    expect(sql).toContain("WHERE DATE_TRUNC('month', (orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')) = $1");
  });

  test("retention cohorts fall on local period boundaries too", () => {
    const { sql } = compile(LOCAL, "retention Orders by id over ordered_at.month periods 2");
    expect(sql).toContain("DATE_TRUNC('month', (orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh'))");
  });

  test("a period-to-date window re-buckets the grid's own column, which is already local, and does not shift it twice", () => {
    const { sql } = compile(LOCAL, "show revenue.mtd() by ordered_at.day");
    expect(sql).toContain("DATE_TRUNC('day', (orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh'))");
    expect(sql).toContain("PARTITION BY DATE_TRUNC('month', ordered_at_day)");
    expect(sql).not.toContain("DATE_TRUNC('month', ordered_at_day AT TIME ZONE");
  });
});

describe("timezones per dialect", () => {
  test("bigquery reads the instant as a local datetime first, so its months land where postgres puts them", () => {
    const { sql } = compile(LOCAL, "show revenue by ordered_at.month", { dialect: bigquery });
    expect(sql).toContain("DATETIME_TRUNC(DATETIME(orders.ordered_at, 'Asia/Ho_Chi_Minh'), MONTH)");
  });

  test("bigquery keeps using date_trunc when no zone was asked for", () => {
    const { sql } = compile(UTC, "show revenue by ordered_at.month", { dialect: bigquery });
    expect(sql).toContain("DATE_TRUNC(orders.ordered_at, MONTH)");
  });

  test("mysql converts the instant out of utc before its date formatting", () => {
    const { sql } = compile(LOCAL, "show revenue by ordered_at.month", { dialect: mysql });
    expect(sql).toContain("DATE_FORMAT(CONVERT_TZ(orders.ordered_at, 'UTC', 'Asia/Ho_Chi_Minh'), '%Y-%m-01')");
  });
});

describe("rejecting timezones that cannot mean anything", () => {
  const withZone = (tz: string) => LOCAL.replace("Asia/Ho_Chi_Minh", tz);

  test("an iana zone name is accepted, including the multi-part and offset-style ones", () => {
    for (const tz of ["UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+7"]) {
      expect(() => compile(withZone(tz), "show revenue by ordered_at.month")).not.toThrow();
    }
  });

  test("a zone name that is not a zone name is refused rather than pasted into the sql", () => {
    expect(() => compile(withZone("not a zone"), "show revenue by ordered_at.month")).toThrow(SemError);
    try {
      compile(withZone("not a zone"), "show revenue by ordered_at.month");
    } catch (error) {
      expect((error as SemError).code).toBe(DiagCode.InvalidDefinition);
    }
  });

  test("a zone name carrying quotes cannot smuggle sql into the query", () => {
    expect(() => compile(withZone("UTC'' OR 1=1"), "show revenue by ordered_at.month")).toThrow(SemError);
  });

  test("two fact tables that bucket the same dimension in different zones is refused, not silently mixed", () => {
    const mixed = `
model Orders {
  table public.orders
  primary_key id
  timezone 'Asia/Ho_Chi_Minh'
  dimension ordered_at: time = ordered_at
  measure gross = sum(amount)
  metric revenue = gross
}
model AdSpend {
  table public.ad_spend
  primary_key id
  timezone 'America/New_York'
  dimension ordered_at: time = ordered_at
  measure cost = sum(cost)
  metric ad_spend = cost
}
`;
    expect(() => compile(mixed, "show revenue, ad_spend by ordered_at.month")).toThrow(/same 'timezone'/);
  });

  test("two fact tables that disagree about when the fiscal year opens is refused as well", () => {
    const mixed = `
model Orders {
  table public.orders
  primary_key id
  fiscal_year_starts 4
  dimension ordered_at: time = ordered_at
  measure gross = sum(amount)
  metric revenue = gross
}
model AdSpend {
  table public.ad_spend
  primary_key id
  fiscal_year_starts 7
  dimension ordered_at: time = ordered_at
  measure cost = sum(cost)
  metric ad_spend = cost
}
`;
    expect(() => compile(mixed, "show revenue, ad_spend by ordered_at.fiscal_year")).toThrow(/fiscal_year_starts/);
  });
});

describe("pre-aggregates remember which calendar they were bucketed on", () => {
  const MV = `${LOCAL}
rollup daily as show revenue by region, ordered_at.day
`;

  test("rolling a local day column up to a month does not shift it a second time", () => {
    const { sql, routedTo } = compile(MV, "show revenue by ordered_at.month");
    expect(routedTo).toBe("daily");
    expect(sql).toContain("DATE_TRUNC('month', daily.ordered_at_day)");
    expect(sql).not.toContain("AT TIME ZONE");
  });

  test("a pre-aggregate holding the raw timestamp is bucketed with the asking model's zone", () => {
    const raw = MV.replace("by region, ordered_at.day", "by region, ordered_at");
    const { sql, routedTo } = compile(raw, "show revenue by ordered_at.month");
    expect(routedTo).toBe("daily");
    expect(sql).toContain("DATE_TRUNC('month', (daily.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh'))");
  });
});
