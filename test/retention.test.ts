import { describe, expect, test } from "vitest";
import { bigquery, compile, DiagCode, mysql, SemError } from "../src/index.js";

const MODEL = `model Events { table public.events primary_key id dimension event: string }`;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SemError) return error.code;
    throw error;
  }
}

describe("retention builds a cohort-by-period matrix", () => {
  test("cohorts are the first period each entity appears in", () => {
    const { sql } = compile(MODEL, "retention Events by user_id over signed_up_at.month periods 3");
    expect(sql).toContain("DATE_TRUNC('month', events.signed_up_at) AS __p");
    expect(sql).toContain("MIN(__p) AS __c FROM cohort_events GROUP BY __e");
  });

  test("the offset is the period distance from an entity's cohort", () => {
    const { sql } = compile(MODEL, "retention Events by user_id over occurred_at.month periods 3");
    expect(sql).toContain(
      "(EXTRACT(YEAR FROM e.__p) - EXTRACT(YEAR FROM c.__c)) * 12 + (EXTRACT(MONTH FROM e.__p) - EXTRACT(MONTH FROM c.__c)) AS __k"
    );
  });

  test("there is one distinct-count column per offset from 0 through the horizon", () => {
    const { sql } = compile(MODEL, "retention Events by user_id over occurred_at.month periods 3");
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN __k = 0 THEN __e END) AS period_0");
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN __k = 3 THEN __e END) AS period_3");
    expect(sql).not.toContain("period_4");
    expect(sql).toContain("GROUP BY cohort");
    expect(sql).toContain("ORDER BY cohort");
  });

  test("a day grain measures the offset in whole days", () => {
    const { sql } = compile(MODEL, "retention Events by user_id over occurred_at.day periods 2");
    expect(sql).toContain("FLOOR(EXTRACT(EPOCH FROM (e.__p - c.__c)) / 86400) AS __k");
  });

  test("a quarter grain divides the month distance by three", () => {
    const { sql } = compile(MODEL, "retention Events by user_id over occurred_at.quarter periods 2");
    expect(sql).toContain(") / 3 AS __k");
  });

  test("retention has no bound parameters", () => {
    expect(compile(MODEL, "retention Events by user_id over occurred_at.month periods 3").params).toEqual([]);
  });
});

describe("retention rejects malformed declarations", () => {
  test("the time reference must carry a grain", () => {
    expect(codeOf(() => compile(MODEL, "retention Events by user_id over occurred_at periods 3"))).toBe(DiagCode.TypeMismatch);
  });

  test("an unknown grain is reported", () => {
    expect(codeOf(() => compile(MODEL, "retention Events by user_id over occurred_at.fortnight periods 3"))).toBe(
      DiagCode.UnknownGrain
    );
  });

  test("the horizon must be at least one period", () => {
    expect(codeOf(() => compile(MODEL, "retention Events by user_id over occurred_at.month periods 0"))).toBe(
      DiagCode.InvalidDefinition
    );
  });

  test("an unknown model is reported", () => {
    expect(codeOf(() => compile(MODEL, "retention Nope by user_id over occurred_at.month periods 3"))).toBe(DiagCode.UnknownModel);
  });
});

describe("retention runs on every dialect, each with its own period-difference primitive", () => {
  const query = "retention Events by user_id over occurred_at.month periods 3";

  test("mysql measures the offset with TIMESTAMPDIFF, counting from the cohort", () => {
    expect(compile(MODEL, query, { dialect: mysql }).sql).toContain("TIMESTAMPDIFF(MONTH, c.__c, e.__p) AS __k");
  });

  test("bigquery measures the offset with DATE_DIFF, counting from the cohort", () => {
    expect(compile(MODEL, query, { dialect: bigquery }).sql).toContain("DATE_DIFF(DATE(e.__p), DATE(c.__c), MONTH) AS __k");
  });

  test("every dialect keeps the same cohort matrix shape", () => {
    for (const dialect of [mysql, bigquery]) {
      const { sql } = compile(MODEL, query, { dialect });
      expect(sql).toContain("WITH cohort_events AS (");
      expect(sql).toContain("COUNT(DISTINCT CASE WHEN __k = 3 THEN __e END)");
      expect(sql).toContain("GROUP BY cohort");
    }
  });

  test("each grain maps to that dialect's own unit", () => {
    const day = compile(MODEL, "retention Events by user_id over occurred_at.day periods 1", { dialect: mysql }).sql;
    expect(day).toContain("TIMESTAMPDIFF(DAY, c.__c, e.__p)");
    const week = compile(MODEL, "retention Events by user_id over occurred_at.week periods 1", { dialect: bigquery }).sql;
    expect(week).toContain("DATE_DIFF(DATE(e.__p), DATE(c.__c), WEEK)");
  });
});
