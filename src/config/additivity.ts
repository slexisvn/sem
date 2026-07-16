import { ReAgg } from "./aggregates.js";

export type SemiRule = "last" | "first";

export const SEMI_RULE_ORDER: ReadonlyMap<SemiRule, "asc" | "desc"> = new Map([
  ["last", "desc"],
  ["first", "asc"]
]);

export type Additivity =
  | { readonly kind: "additive"; readonly reduce: ReAgg }
  | { readonly kind: "semi"; readonly reduce: ReAgg; readonly rule: SemiRule }
  | { readonly kind: "none" };

export const NON_ADDITIVE: Additivity = { kind: "none" };

export function fromReAgg(reagg: ReAgg): Additivity {
  return reagg === ReAgg.None ? NON_ADDITIVE : { kind: "additive", reduce: reagg };
}

export function windowReduce(add: Additivity): ReAgg {
  return add.kind === "additive" ? add.reduce : ReAgg.None;
}

export function meetAdditivity(a: Additivity, b: Additivity): Additivity {
  const sum = a.kind === "additive" && a.reduce === ReAgg.Sum && b.kind === "additive" && b.reduce === ReAgg.Sum;
  return sum ? a : NON_ADDITIVE;
}
