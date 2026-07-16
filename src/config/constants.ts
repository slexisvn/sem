import { TokKind } from "../lexer/token.js";

export enum AggFunc {
  Sum = "sum",
  Count = "count",
  Avg = "avg",
  Min = "min",
  Max = "max",
  Median = "median",
  Percentile = "percentile",
  ApproxMedian = "approx_median",
  ApproxPercentile = "approx_percentile"
}

export enum TimeGrain {
  Day = "day",
  Week = "week",
  Month = "month",
  Quarter = "quarter",
  Year = "year",
  FiscalQuarter = "fiscal_quarter",
  FiscalYear = "fiscal_year"
}

export type CalendarGrain = Exclude<TimeGrain, TimeGrain.FiscalQuarter | TimeGrain.FiscalYear>;

export const CALENDAR_GRAIN: ReadonlyMap<TimeGrain, CalendarGrain> = new Map([
  [TimeGrain.FiscalQuarter, TimeGrain.Quarter],
  [TimeGrain.FiscalYear, TimeGrain.Year]
]);

export function calendarGrain(grain: TimeGrain): CalendarGrain {
  return CALENDAR_GRAIN.get(grain) ?? (grain as CalendarGrain);
}

export const FISCAL_START_MIN = 1;
export const FISCAL_START_MAX = 12;

export interface TimeFrame {
  readonly tz?: string;
  readonly fiscalStart?: number;
}

export function fiscalOffset(frame: TimeFrame | undefined): number {
  return (frame?.fiscalStart ?? FISCAL_START_MIN) - FISCAL_START_MIN;
}

export function frameEquals(a: TimeFrame | undefined, b: TimeFrame | undefined): boolean {
  return a?.tz === b?.tz && fiscalOffset(a) === fiscalOffset(b);
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
  Share = "share",
  Of = "of",
  Mtd = "mtd",
  Qtd = "qtd",
  Ytd = "ytd"
}

export const TRANSFORM_NAMES: ReadonlySet<string> = new Set<string>(Object.values(TransformKind));

export const SERIESLESS_TRANSFORMS: ReadonlySet<TransformKind> = new Set([TransformKind.Share, TransformKind.Of]);

export const PERIOD_TO_DATE_GRAIN: ReadonlyMap<TransformKind, TimeGrain> = new Map([
  [TransformKind.Mtd, TimeGrain.Month],
  [TransformKind.Qtd, TimeGrain.Quarter],
  [TransformKind.Ytd, TimeGrain.Year]
]);

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
  [TimeGrain.Year, 365],
  [TimeGrain.FiscalQuarter, 90],
  [TimeGrain.FiscalYear, 365]
]);

export const GRAIN_ROLLUP: ReadonlyMap<TimeGrain, ReadonlySet<TimeGrain>> = new Map([
  [
    TimeGrain.Day,
    new Set([
      TimeGrain.Day,
      TimeGrain.Week,
      TimeGrain.Month,
      TimeGrain.Quarter,
      TimeGrain.Year,
      TimeGrain.FiscalQuarter,
      TimeGrain.FiscalYear
    ])
  ],
  [TimeGrain.Week, new Set([TimeGrain.Week])],
  [
    TimeGrain.Month,
    new Set([TimeGrain.Month, TimeGrain.Quarter, TimeGrain.Year, TimeGrain.FiscalQuarter, TimeGrain.FiscalYear])
  ],
  [TimeGrain.Quarter, new Set([TimeGrain.Quarter, TimeGrain.Year])],
  [TimeGrain.Year, new Set([TimeGrain.Year])],
  [TimeGrain.FiscalQuarter, new Set([TimeGrain.FiscalQuarter, TimeGrain.FiscalYear])],
  [TimeGrain.FiscalYear, new Set([TimeGrain.FiscalYear])]
]);

export const GRAIN_PERIODS_PER_YEAR: ReadonlyMap<TimeGrain, number> = new Map([
  [TimeGrain.Day, 365],
  [TimeGrain.Week, 52],
  [TimeGrain.Month, 12],
  [TimeGrain.Quarter, 4],
  [TimeGrain.Year, 1],
  [TimeGrain.FiscalQuarter, 4],
  [TimeGrain.FiscalYear, 1]
]);

export interface GrainStep {
  readonly count: number;
  readonly unit: string;
}

export const GRAIN_STEP: ReadonlyMap<TimeGrain, GrainStep> = new Map([
  [TimeGrain.Day, { count: 1, unit: "day" }],
  [TimeGrain.Week, { count: 1, unit: "week" }],
  [TimeGrain.Month, { count: 1, unit: "month" }],
  [TimeGrain.Quarter, { count: 3, unit: "month" }],
  [TimeGrain.Year, { count: 1, unit: "year" }],
  [TimeGrain.FiscalQuarter, { count: 3, unit: "month" }],
  [TimeGrain.FiscalYear, { count: 1, unit: "year" }]
]);

export const KEYWORDS: ReadonlyMap<string, TokKind> = new Map([
  ["model", TokKind.Model],
  ["table", TokKind.Table],
  ["primary_key", TokKind.PrimaryKey],
  ["timezone", TokKind.Timezone],
  ["fiscal_year_starts", TokKind.FiscalYearStarts],
  ["join", TokKind.Join],
  ["on", TokKind.On],
  ["asof", TokKind.Asof],
  ["dimension", TokKind.Dimension],
  ["measure", TokKind.Measure],
  ["metric", TokKind.Metric],
  ["segment", TokKind.Segment],
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
  ["funnel", TokKind.Funnel],
  ["steps", TokKind.Steps],
  ["over", TokKind.Over],
  ["retention", TokKind.Retention],
  ["periods", TokKind.Periods],
  ["and", TokKind.And],
  ["or", TokKind.Or],
  ["not", TokKind.Not],
  ["in", TokKind.In],
  ["between", TokKind.Between],
  ["like", TokKind.Like],
  ["true", TokKind.True],
  ["false", TokKind.False]
]);

export const ASOF_ORDER: ReadonlyMap<CmpOp, "asc" | "desc"> = new Map([
  [CmpOp.Gte, "desc"],
  [CmpOp.Gt, "desc"],
  [CmpOp.Lte, "asc"],
  [CmpOp.Lt, "asc"]
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
export const DEDUP_KEY_ALIAS = "__pk";
export const DEDUP_VALUE_PREFIX = "__v";
export const SEMI_ORDER_PREFIX = "__o";
export const SEMI_WINDOW_PREFIX = "__w";
export const FUNNEL_CTE = "funnel";
export const FUNNEL_STEP_PREFIX = "__s";
export const FUNNEL_ENTITY_ALIAS = "__entity";
export const RETENTION_EVENTS_CTE = "cohort_events";
export const RETENTION_COHORT_CTE = "cohorts";
export const RETENTION_ACTIVITY_CTE = "activity";
export const RETENTION_ENTITY = "__e";
export const RETENTION_PERIOD = "__p";
export const RETENTION_COHORT = "__c";
export const RETENTION_OFFSET = "__k";
export const RETENTION_COHORT_COL = "cohort";
export const RETENTION_PERIOD_PREFIX = "period_";
export const GRID_CTE = "grid";
export const SPINE_CTE = "spine";
export const DENSE_CTE = "dense";
export const SPINE_PERIOD_COL = "period";

export type FanOutStrategy = "cte-per-fact";

export interface CompileOptions {
  readonly fanOut: FanOutStrategy;
}

export const DEFAULT_OPTIONS: CompileOptions = {
  fanOut: "cte-per-fact"
};
