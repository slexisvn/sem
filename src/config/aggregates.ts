import { AggFunc } from "./constants.js";

export enum ReAgg {
  Sum = "sum",
  Min = "min",
  Max = "max",
  None = "none"
}

interface AggSemantics {
  readonly reagg: ReAgg;
  readonly allowsDistinct: boolean;
  readonly quantile?: number | null;
  readonly approx?: boolean;
}

const AGG_SEMANTICS: ReadonlyMap<AggFunc, AggSemantics> = new Map([
  [AggFunc.Sum, { reagg: ReAgg.Sum, allowsDistinct: true }],
  [AggFunc.Count, { reagg: ReAgg.Sum, allowsDistinct: true }],
  [AggFunc.Avg, { reagg: ReAgg.None, allowsDistinct: true }],
  [AggFunc.Min, { reagg: ReAgg.Min, allowsDistinct: false }],
  [AggFunc.Max, { reagg: ReAgg.Max, allowsDistinct: false }],
  [AggFunc.Median, { reagg: ReAgg.None, allowsDistinct: false, quantile: 0.5 }],
  [AggFunc.Percentile, { reagg: ReAgg.None, allowsDistinct: false, quantile: null }],
  [AggFunc.ApproxMedian, { reagg: ReAgg.None, allowsDistinct: false, quantile: 0.5, approx: true }],
  [AggFunc.ApproxPercentile, { reagg: ReAgg.None, allowsDistinct: false, quantile: null, approx: true }]
]);

export const REAGG_SQL: ReadonlyMap<ReAgg, string> = new Map([
  [ReAgg.Sum, "SUM"],
  [ReAgg.Min, "MIN"],
  [ReAgg.Max, "MAX"]
]);

export const DISTINCT_KEYWORD = "distinct";

export function aggAllowsDistinct(func: AggFunc): boolean {
  return AGG_SEMANTICS.get(func)!.allowsDistinct;
}

export function aggReAgg(func: AggFunc, distinct: boolean): ReAgg {
  return distinct ? ReAgg.None : AGG_SEMANTICS.get(func)!.reagg;
}

export function aggQuantile(func: AggFunc): number | null | undefined {
  return AGG_SEMANTICS.get(func)!.quantile;
}

export function aggTakesParameter(func: AggFunc): boolean {
  return AGG_SEMANTICS.get(func)!.quantile === null;
}

export function aggIsApprox(func: AggFunc): boolean {
  return AGG_SEMANTICS.get(func)!.approx === true;
}
