import { AggFunc, ArithOp, CmpOp, DimType, TimeGrain, TransformKind } from "../config/constants.js";
import { ReAgg } from "../config/aggregates.js";
import { Additivity } from "../config/additivity.js";
import { Unit } from "../config/units.js";
import { Span } from "../lexer/token.js";

export interface ColRef {
  readonly model: string;
  readonly column: string;
}

export type ColExpr =
  | { readonly k: "col"; readonly ref: ColRef }
  | { readonly k: "num"; readonly value: number }
  | { readonly k: "trunc"; readonly grain: TimeGrain; readonly arg: ColExpr }
  | { readonly k: "bin"; readonly op: ArithOp; readonly left: ColExpr; readonly right: ColExpr };

export interface ValueRef {
  readonly k: "param";
  readonly value: string | number | boolean;
}

export type Cond =
  | { readonly k: "cmp"; readonly op: CmpOp; readonly left: ColExpr; readonly right: ColExpr | ValueRef }
  | { readonly k: "and"; readonly left: Cond; readonly right: Cond }
  | { readonly k: "or"; readonly left: Cond; readonly right: Cond }
  | { readonly k: "not"; readonly operand: Cond }
  | { readonly k: "in"; readonly left: ColExpr; readonly values: ValueRef[] }
  | { readonly k: "between"; readonly left: ColExpr; readonly lo: ValueRef; readonly hi: ValueRef }
  | { readonly k: "like"; readonly left: ColExpr; readonly pattern: ValueRef };

export type MExpr =
  | {
      readonly k: "agg";
      readonly model: string;
      readonly func: AggFunc;
      readonly arg: ColExpr;
      readonly distinct: boolean;
      readonly filter?: Cond;
      readonly unit?: Unit;
      readonly add?: Additivity;
      readonly semiCol?: ColExpr;
      readonly quantile?: number;
    }
  | { readonly k: "bin"; readonly op: ArithOp; readonly left: MExpr; readonly right: MExpr }
  | { readonly k: "num"; readonly value: number };

export type MetricCond =
  | { readonly k: "cmp"; readonly op: CmpOp; readonly left: MExpr; readonly right: ValueRef }
  | { readonly k: "and"; readonly left: MetricCond; readonly right: MetricCond }
  | { readonly k: "or"; readonly left: MetricCond; readonly right: MetricCond }
  | { readonly k: "not"; readonly operand: MetricCond }
  | { readonly k: "between"; readonly left: MExpr; readonly lo: ValueRef; readonly hi: ValueRef };

export type Strategy = "single" | "multi";

export interface AsOfInfo {
  readonly left: ColRef;
  readonly op: CmpOp;
  readonly right: ColRef;
}

export interface JoinEdge {
  readonly fromModel: string;
  readonly target: string;
  readonly left: ColRef;
  readonly op: CmpOp;
  readonly right: ColRef;
  readonly asof?: AsOfInfo;
  readonly span: Span;
}

export interface FactPlan {
  readonly model: string;
  readonly joins: JoinEdge[];
  filter?: Cond;
  fannedOut?: boolean;
}

export interface DimPlan {
  readonly outputName: string;
  readonly type: DimType;
  readonly grain?: TimeGrain;
  readonly perFact: Map<string, ColExpr>;
}

export type TransformIR =
  | { readonly kind: TransformKind.Mom | TransformKind.Yoy; readonly lag: number; readonly orderDim: string; readonly partition: string[] }
  | { readonly kind: TransformKind.Rolling; readonly rows: number; readonly orderDim: string; readonly combinator: ReAgg; readonly partition: string[] }
  | { readonly kind: TransformKind.Cumulative; readonly orderDim: string; readonly combinator: ReAgg; readonly partition: string[] }
  | {
      readonly kind: TransformKind.Mtd | TransformKind.Qtd | TransformKind.Ytd;
      readonly orderDim: string;
      readonly combinator: ReAgg;
      readonly partition: string[];
      readonly periodGrain: TimeGrain;
    }
  | { readonly kind: TransformKind.Share; readonly partition: string[] }
  | { readonly kind: TransformKind.Of; readonly combinator: ReAgg; readonly partition: string[] };

export interface SelectMetric {
  readonly name: string;
  readonly baseName: string;
  readonly expr: MExpr;
  readonly transform?: TransformIR;
}

export interface Plan {
  readonly strategy: Strategy;
  readonly windowed: boolean;
  readonly facts: FactPlan[];
  readonly dims: DimPlan[];
  readonly selects: SelectMetric[];
  readonly orderBy?: { readonly name: string; readonly dir: "asc" | "desc" };
  readonly limit?: number;
  readonly having?: MetricCond;
}

export interface FunnelStepIR {
  readonly name: string;
  readonly cond: Cond;
}

export interface FunnelPlan {
  readonly model: string;
  readonly entity: ColRef;
  readonly time: ColRef;
  readonly steps: FunnelStepIR[];
}

export interface RetentionPlan {
  readonly model: string;
  readonly entity: ColRef;
  readonly time: ColRef;
  readonly grain: TimeGrain;
  readonly periods: number;
}

export function columnModelOf(expr: ColExpr, into: Set<string> = new Set()): Set<string> {
  switch (expr.k) {
    case "col":
      into.add(expr.ref.model);
      return into;
    case "num":
      return into;
    case "trunc":
      return columnModelOf(expr.arg, into);
    case "bin":
      columnModelOf(expr.left, into);
      columnModelOf(expr.right, into);
      return into;
  }
}

export interface SqlResult {
  readonly sql: string;
  readonly params: (string | number | boolean)[];
}

export function hasSemiAdditive(expr: MExpr): boolean {
  switch (expr.k) {
    case "agg":
      return expr.add?.kind === "semi";
    case "bin":
      return hasSemiAdditive(expr.left) || hasSemiAdditive(expr.right);
    case "num":
      return false;
  }
}

export function modelSet(expr: MExpr, into: Set<string> = new Set()): Set<string> {
  switch (expr.k) {
    case "agg":
      into.add(expr.model);
      return into;
    case "bin":
      modelSet(expr.left, into);
      modelSet(expr.right, into);
      return into;
    case "num":
      return into;
  }
}

