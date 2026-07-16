import { describe, expect, test } from "vitest";
import { compile, DiagCode, SemError } from "../src/index.js";

const MODEL = `
model Orders {
  table public.orders
  primary_key id
  dimension region: string
  dimension status: string
  segment paid = status = 'paid'
  segment domestic = region = 'VN'
  segment domestic_paid = paid and domestic
  measure gross = sum(amount)
  measure cnt = count(id)
  metric revenue = gross where paid
  metric vn_revenue = gross where domestic_paid
  metric orders = cnt
}
policy vn_only on Orders restrict domestic
`;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SemError) return error.code;
    throw error;
  }
}

describe("segments are reusable named filters", () => {
  test("a metric filter expands a segment to its condition", () => {
    expect(compile(MODEL, "show revenue by region").sql).toContain("CASE WHEN orders.status = $1 THEN orders.amount END");
  });

  test("segments compose with each other", () => {
    expect(compile(MODEL, "show vn_revenue by region").sql).toContain(
      "CASE WHEN (orders.status = $1 AND orders.region = $2) THEN orders.amount END"
    );
  });

  test("a query where-clause can reference a segment", () => {
    const out = compile(MODEL, "show orders by region where paid", { policies: [] }).sql;
    expect(out).toContain("WHERE orders.status = $1");
  });

  test("a policy restriction can reference a segment", () => {
    const out = compile(MODEL, "show orders by region", { policies: ["vn_only"] }).sql;
    expect(out).toContain("orders.region = $1");
  });

  test("a segment cannot share a name with a dimension", () => {
    const clash = MODEL.replace("segment paid = status = 'paid'", "segment region = status = 'paid'");
    expect(codeOf(() => compile(clash, "show orders by region"))).toBe(DiagCode.DuplicateName);
  });

  test("a self-referential segment is rejected", () => {
    const cyclic = MODEL.replace("segment domestic_paid = paid and domestic", "segment domestic_paid = domestic_paid and paid");
    expect(codeOf(() => compile(cyclic, "show vn_revenue by region"))).toBe(DiagCode.CyclicMetric);
  });
});
