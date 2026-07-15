import { describe, expect, test } from "vitest";
import { DiagCode, SemError, parseModels, parseQuery, Catalog, analyze } from "../src/index.js";
import { MODELS, run } from "./fixtures.js";

function analyzeQuery(models: string, query: string): void {
  const cat = Catalog.build(parseModels(models));
  analyze(cat, parseQuery(query));
}

describe("positioned diagnostics", () => {
  test("unknown metric reports a suggestion", () => {
    try {
      run("show revenu by region");
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(SemError);
      const sem = err as SemError;
      expect(sem.code).toBe(DiagCode.UnknownMetric);
      expect(sem.suggestion).toBe("revenue");
      expect(sem.message).toContain("line 1:6");
    }
  });

  test("unknown dimension reports a suggestion", () => {
    const err = captureError(() => run("show revenue by regon"));
    expect(err.code).toBe(DiagCode.UnknownDimension);
    expect(err.suggestion).toBe("region");
  });

  test("cyclic derived metrics are rejected", () => {
    const models = `
      model M {
        table public.m
        primary_key id
        metric a = b
        metric b = a
      }
    `;
    const err = captureError(() => analyzeQuery(models, "show a"));
    expect(err.code).toBe(DiagCode.CyclicMetric);
  });

  test("type mismatch: time grain on a string dimension", () => {
    const err = captureError(() => run("show revenue by region.month"));
    expect(err.code).toBe(DiagCode.TypeMismatch);
  });

  test("type mismatch: comparing a string dimension to a number", () => {
    const err = captureError(() => run("show revenue where region = 5"));
    expect(err.code).toBe(DiagCode.TypeMismatch);
  });

  test("unreachable join: dimension with no path to the base model", () => {
    const models = `
      model A {
        table public.a
        primary_key id
        measure total = sum(x)
        metric total_m = sum(x)
      }
      model B {
        table public.b
        primary_key id
        dimension label: string = label
      }
    `;
    const err = captureError(() => analyzeQuery(models, "show total_m by B.label"));
    expect(err.code).toBe(DiagCode.UnreachableJoin);
  });

  test("ambiguous join: two paths to the same model", () => {
    const models = `
      model Base {
        table public.base
        primary_key id
        join Mid1 on m1_id = Mid1.id (many_to_one)
        join Mid2 on m2_id = Mid2.id (many_to_one)
        metric total = sum(x)
      }
      model Mid1 {
        table public.mid1
        primary_key id
        join Leaf on leaf_id = Leaf.id (many_to_one)
      }
      model Mid2 {
        table public.mid2
        primary_key id
        join Leaf on leaf_id = Leaf.id (many_to_one)
      }
      model Leaf {
        table public.leaf
        primary_key id
        dimension label: string = label
      }
    `;
    const err = captureError(() => analyzeQuery(models, "show total by Leaf.label"));
    expect(err.code).toBe(DiagCode.AmbiguousJoin);
  });

  test("ambiguous bare dimension reachable through two joined models", () => {
    const models = `
      model Base {
        table public.base
        primary_key id
        join L on l_id = L.id (many_to_one)
        join R on r_id = R.id (many_to_one)
        metric total = sum(x)
      }
      model L {
        table public.l
        primary_key id
        dimension label: string = label
      }
      model R {
        table public.r
        primary_key id
        dimension label: string = label
      }
    `;
    const err = captureError(() => analyzeQuery(models, "show total by label"));
    expect(err.code).toBe(DiagCode.AmbiguousReference);
  });

  test("fan-out via a one-to-many dimension is refused rather than silently doubled", () => {
    const err = captureError(() => run("show revenue by Items.sku"));
    expect(err.code).toBe(DiagCode.Unsupported);
  });

  test("catalog rejects duplicate model names", () => {
    const models = `${MODELS}\nmodel Orders { table public.dupe primary_key id }`;
    const err = captureError(() => Catalog.build(parseModels(models)));
    expect(err.code).toBe(DiagCode.DuplicateName);
  });

  test("order by must reference a shown metric", () => {
    const err = captureError(() => run("show revenue by region order by aov desc"));
    expect(err.code).toBe(DiagCode.UnknownMetric);
  });
});

function captureError(fn: () => unknown): SemError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SemError) return err;
    throw err;
  }
  throw new Error("expected a SemError to be thrown");
}
