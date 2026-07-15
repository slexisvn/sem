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
}

const AGG_SEMANTICS: ReadonlyMap<AggFunc, AggSemantics> = new Map([
  [AggFunc.Sum, { reagg: ReAgg.Sum, allowsDistinct: true }],
  [AggFunc.Count, { reagg: ReAgg.Sum, allowsDistinct: true }],
  [AggFunc.Avg, { reagg: ReAgg.None, allowsDistinct: true }],
  [AggFunc.Min, { reagg: ReAgg.Min, allowsDistinct: false }],
  [AggFunc.Max, { reagg: ReAgg.Max, allowsDistinct: false }]
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
