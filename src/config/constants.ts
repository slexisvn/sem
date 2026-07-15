import { TokKind } from "../lexer/token.js";

export enum AggFunc {
  Sum = "sum",
  Count = "count",
  Avg = "avg",
  Min = "min",
  Max = "max"
}

export enum TimeGrain {
  Day = "day",
  Week = "week",
  Month = "month",
  Quarter = "quarter",
  Year = "year"
}

export enum Cardinality {
  ManyToOne = "many_to_one",
  OneToMany = "one_to_many",
  OneToOne = "one_to_one",
  ManyToMany = "many_to_many"
}

export enum DimType {
  String = "string",
  Number = "number",
  Boolean = "boolean",
  Time = "time"
}

export enum ArithOp {
  Add = "+",
  Sub = "-",
  Mul = "*",
  Div = "/"
}

export enum CmpOp {
  Eq = "=",
  Neq = "!=",
  Lt = "<",
  Lte = "<=",
  Gt = ">",
  Gte = ">="
}

export enum LogicOp {
  And = "and",
  Or = "or"
}

export enum TransformKind {
  Mom = "mom",
  Yoy = "yoy",
  Rolling = "rolling",
  Cumulative = "cumulative",
  Share = "share"
}

export const TRANSFORM_NAMES: ReadonlySet<string> = new Set<string>(Object.values(TransformKind));

export const DURATION_UNIT_DAYS: ReadonlyMap<string, number> = new Map([
  ["d", 1],
  ["w", 7],
  ["m", 30],
  ["q", 90],
  ["y", 365]
]);

export const GRAIN_DAYS: ReadonlyMap<TimeGrain, number> = new Map([
  [TimeGrain.Day, 1],
  [TimeGrain.Week, 7],
  [TimeGrain.Month, 30],
  [TimeGrain.Quarter, 90],
  [TimeGrain.Year, 365]
]);

export const GRAIN_PERIODS_PER_YEAR: ReadonlyMap<TimeGrain, number> = new Map([
  [TimeGrain.Day, 365],
  [TimeGrain.Week, 52],
  [TimeGrain.Month, 12],
  [TimeGrain.Quarter, 4],
  [TimeGrain.Year, 1]
]);

export const KEYWORDS: ReadonlyMap<string, TokKind> = new Map([
  ["model", TokKind.Model],
  ["table", TokKind.Table],
  ["primary_key", TokKind.PrimaryKey],
  ["join", TokKind.Join],
  ["on", TokKind.On],
  ["dimension", TokKind.Dimension],
  ["measure", TokKind.Measure],
  ["metric", TokKind.Metric],
  ["show", TokKind.Show],
  ["by", TokKind.By],
  ["where", TokKind.Where],
  ["having", TokKind.Having],
  ["order", TokKind.Order],
  ["asc", TokKind.Asc],
  ["desc", TokKind.Desc],
  ["top", TokKind.Top],
  ["assert", TokKind.Assert],
  ["policy", TokKind.Policy],
  ["restrict", TokKind.Restrict],
  ["materialize", TokKind.Materialize],
  ["as", TokKind.As],
  ["and", TokKind.And],
  ["or", TokKind.Or],
  ["not", TokKind.Not],
  ["in", TokKind.In],
  ["between", TokKind.Between],
  ["like", TokKind.Like],
  ["true", TokKind.True],
  ["false", TokKind.False]
]);

export const AGG_FUNCS: ReadonlySet<string> = new Set<string>(Object.values(AggFunc));
export const TIME_GRAINS: ReadonlySet<string> = new Set<string>(Object.values(TimeGrain));
export const CARDINALITIES: ReadonlySet<string> = new Set<string>(Object.values(Cardinality));
export const DIM_TYPES: ReadonlySet<string> = new Set<string>(Object.values(DimType));

export const FANOUT_CARDINALITIES: ReadonlySet<Cardinality> = new Set([
  Cardinality.OneToMany,
  Cardinality.ManyToMany
]);

export const COMMENT_CHAR = "#";
export const CTE_SUFFIX = "_agg";
export const COMPONENT_PREFIX = "m";

export type FanOutStrategy = "cte-per-fact";

export interface CompileOptions {
  readonly fanOut: FanOutStrategy;
}

export const DEFAULT_OPTIONS: CompileOptions = {
  fanOut: "cte-per-fact"
};
