import { describe, expect, test } from "vitest";
import { bigquery, compile, DiagCode, mysql, SemError } from "../src/index.js";

const MODEL = `
model Events {
  table public.events
  primary_key id
  dimension event: string
  dimension plan: string
  segment purchase = event = 'purchase'
}`;

const FUNNEL = `funnel Events by user_id over occurred_at
  steps viewed = event = 'view', carted = event = 'add_to_cart', purchased = purchase`;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SemError) return error.code;
    throw error;
  }
}

describe("funnel counts entities progressing through ordered steps", () => {
  test("each step becomes a first-occurrence timestamp grouped by the entity", () => {
    const { sql } = compile(MODEL, FUNNEL);
    expect(sql).toContain("WITH funnel AS (");
    expect(sql).toContain("SELECT events.user_id AS __entity");
    expect(sql).toContain("MIN(CASE WHEN events.event = $1 THEN events.occurred_at END) AS __s0");
    expect(sql).toContain("MIN(CASE WHEN events.event = $3 THEN events.occurred_at END) AS __s2");
    expect(sql).toContain("GROUP BY events.user_id");
  });

  test("step counts require every prior step to have happened no later", () => {
    const { sql } = compile(MODEL, FUNNEL);
    expect(sql).toContain("SUM(CASE WHEN funnel.__s0 IS NOT NULL THEN 1 ELSE 0 END) AS viewed");
    expect(sql).toContain("SUM(CASE WHEN funnel.__s0 IS NOT NULL AND funnel.__s1 >= funnel.__s0 THEN 1 ELSE 0 END) AS carted");
    expect(sql).toContain(
      "SUM(CASE WHEN funnel.__s0 IS NOT NULL AND funnel.__s1 >= funnel.__s0 AND funnel.__s2 >= funnel.__s1 THEN 1 ELSE 0 END) AS purchased"
    );
  });

  test("step conditions are parameterized in order", () => {
    expect(compile(MODEL, FUNNEL).params).toEqual(["view", "add_to_cart", "purchase"]);
  });

  test("a step condition can reuse a segment", () => {
    expect(compile(MODEL, FUNNEL).sql).toContain("MIN(CASE WHEN events.event = $3 THEN events.occurred_at END) AS __s2");
  });

  test("the counting pass is portable across dialects with no lateral or filter syntax", () => {
    for (const dialect of [mysql, bigquery]) {
      expect(compile(MODEL, FUNNEL, { dialect }).sql).toContain("SUM(CASE WHEN funnel.__s0 IS NOT NULL THEN 1 ELSE 0 END)");
    }
  });
});

describe("funnel rejects malformed declarations", () => {
  test("a funnel needs at least two steps", () => {
    expect(codeOf(() => compile(MODEL, "funnel Events by user_id over occurred_at steps only = event = 'view'"))).toBe(
      DiagCode.InvalidDefinition
    );
  });

  test("duplicate step names are rejected", () => {
    const dup = "funnel Events by user_id over occurred_at steps a = event = 'view', a = event = 'buy'";
    expect(codeOf(() => compile(MODEL, dup))).toBe(DiagCode.DuplicateName);
  });

  test("an unknown model is reported", () => {
    const bad = "funnel Nope by user_id over occurred_at steps a = event = 'view', b = event = 'buy'";
    expect(codeOf(() => compile(MODEL, bad))).toBe(DiagCode.UnknownModel);
  });

  test("the entity key must be a plain column", () => {
    const bad = "funnel Events by Other.user_id over occurred_at steps a = event = 'view', b = event = 'buy'";
    expect(codeOf(() => compile(MODEL, bad))).toBe(DiagCode.TypeMismatch);
  });
});
