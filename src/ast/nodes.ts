import { Span } from "../lexer/token.js";
import { SemiRule } from "../config/additivity.js";
import { Unit } from "../config/units.js";

export enum NodeKind {
  Model = "Model",
  Join = "Join",
  Dimension = "Dimension",
  Measure = "Measure",
  Metric = "Metric",
  Segment = "Segment",
  Hierarchy = "Hierarchy",
  Query = "Query",
  Ident = "Ident",
  Member = "Member",
  Literal = "Literal",
  Call = "Call",
  Binary = "Binary",
  Unary = "Unary",
  Between = "Between",
  In = "In",
  MetricSelect = "MetricSelect",
  SelectBinary = "SelectBinary",
  SelectNumber = "SelectNumber",
  SelectItem = "SelectItem",
  Policy = "Policy",
  Assert = "Assert",
  Materialize = "Materialize",
  Funnel = "Funnel",
  Retention = "Retention"
}

export type LiteralType = "string" | "number" | "boolean";
export type ArithBinaryOp = "+" | "-" | "*" | "/";
export type BinaryOp = ArithBinaryOp | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or" | "like";
export type UnaryOp = "-" | "not";

export interface IdentExpr {
  readonly kind: NodeKind.Ident;
  readonly name: string;
  readonly span: Span;
}

export interface MemberExpr {
  readonly kind: NodeKind.Member;
  readonly object: IdentExpr | MemberExpr;
  readonly name: string;
  readonly nameSpan: Span;
  readonly span: Span;
}

export interface LiteralExpr {
  readonly kind: NodeKind.Literal;
  readonly value: string | number | boolean;
  readonly literalType: LiteralType;
  readonly span: Span;
}

export interface CallExpr {
  readonly kind: NodeKind.Call;
  readonly callee: string;
  readonly calleeSpan: Span;
  readonly args: Expr[];
  readonly distinct: boolean;
  readonly span: Span;
}

export interface BinaryExpr {
  readonly kind: NodeKind.Binary;
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
  readonly span: Span;
}

export interface UnaryExpr {
  readonly kind: NodeKind.Unary;
  readonly op: UnaryOp;
  readonly operand: Expr;
  readonly span: Span;
}

export interface BetweenExpr {
  readonly kind: NodeKind.Between;
  readonly value: Expr;
  readonly lower: Expr;
  readonly upper: Expr;
  readonly span: Span;
}

export interface InExpr {
  readonly kind: NodeKind.In;
  readonly value: Expr;
  readonly list: Expr[];
  readonly span: Span;
}

export type Expr =
  | IdentExpr
  | MemberExpr
  | LiteralExpr
  | CallExpr
  | BinaryExpr
  | UnaryExpr
  | BetweenExpr
  | InExpr;

export type RefExpr = IdentExpr | MemberExpr;

export interface AsOfClause {
  readonly left: RefExpr;
  readonly op: BinaryOp;
  readonly right: RefExpr;
  readonly span: Span;
}

export interface JoinDecl {
  readonly kind: NodeKind.Join;
  readonly target: string;
  readonly targetSpan: Span;
  readonly left: RefExpr;
  readonly op: BinaryOp;
  readonly right: RefExpr;
  readonly asof?: AsOfClause;
  readonly cardinality: string;
  readonly span: Span;
}

export interface DimensionDecl {
  readonly kind: NodeKind.Dimension;
  readonly name: string;
  readonly nameSpan: Span;
  readonly dimType: string;
  readonly dimTypeSpan: Span;
  readonly expr: Expr;
  readonly span: Span;
}

export type AggOverride =
  | { readonly kind: "non_additive"; readonly span: Span }
  | { readonly kind: "semi"; readonly rule: SemiRule; readonly dim: string; readonly dimSpan: Span; readonly span: Span };

export interface MeasureDecl {
  readonly kind: NodeKind.Measure;
  readonly name: string;
  readonly nameSpan: Span;
  readonly expr: Expr;
  readonly unit?: Unit;
  readonly additivity?: AggOverride;
  readonly span: Span;
}

export interface MetricDecl {
  readonly kind: NodeKind.Metric;
  readonly name: string;
  readonly nameSpan: Span;
  readonly expr: Expr;
  readonly filter?: Expr;
  readonly span: Span;
}

export interface SegmentDecl {
  readonly kind: NodeKind.Segment;
  readonly name: string;
  readonly nameSpan: Span;
  readonly expr: Expr;
  readonly span: Span;
}

export interface HierarchyLevel {
  readonly name: string;
  readonly span: Span;
}

export interface HierarchyDecl {
  readonly kind: NodeKind.Hierarchy;
  readonly name: string;
  readonly nameSpan: Span;
  readonly levels: HierarchyLevel[];
  readonly span: Span;
}

export interface ModelDecl {
  readonly kind: NodeKind.Model;
  readonly name: string;
  readonly nameSpan: Span;
  readonly table: string;
  readonly primaryKey: string;
  readonly timezone?: string;
  readonly timezoneSpan?: Span;
  readonly fiscalStart?: number;
  readonly fiscalStartSpan?: Span;
  readonly joins: JoinDecl[];
  readonly dimensions: DimensionDecl[];
  readonly measures: MeasureDecl[];
  readonly metrics: MetricDecl[];
  readonly segments: SegmentDecl[];
  readonly hierarchies: HierarchyDecl[];
  readonly span: Span;
}

export type SortDir = "asc" | "desc";

export interface DurationArg {
  readonly kind: "duration";
  readonly text: string;
  readonly span: Span;
}

export interface DimArg {
  readonly kind: "dim";
  readonly ref: RefExpr;
  readonly span: Span;
}

export type TransformArg = DurationArg | DimArg;

export interface TransformCall {
  readonly name: string;
  readonly nameSpan: Span;
  readonly args: TransformArg[];
  readonly span: Span;
}

export interface MetricSelect {
  readonly kind: NodeKind.MetricSelect;
  readonly base: RefExpr;
  readonly transform?: TransformCall;
  readonly span: Span;
}

export interface SelectBinaryExpr {
  readonly kind: NodeKind.SelectBinary;
  readonly op: ArithBinaryOp;
  readonly left: SelectExpr;
  readonly right: SelectExpr;
  readonly span: Span;
}

export interface SelectNumberExpr {
  readonly kind: NodeKind.SelectNumber;
  readonly value: number;
  readonly span: Span;
}

export type SelectExpr = MetricSelect | SelectBinaryExpr | SelectNumberExpr;

export interface SelectItem {
  readonly kind: NodeKind.SelectItem;
  readonly expr: SelectExpr;
  readonly alias?: string;
  readonly aliasSpan?: Span;
  readonly span: Span;
}

export interface OrderByClause {
  readonly metric: MetricSelect;
  readonly dir: SortDir;
}

export interface QueryDecl {
  readonly kind: NodeKind.Query;
  readonly metrics: SelectItem[];
  readonly dimensions: RefExpr[];
  readonly where?: Expr;
  readonly having?: Expr;
  readonly orderBy?: OrderByClause;
  readonly top?: number;
  readonly span: Span;
}

export interface PolicyDecl {
  readonly kind: NodeKind.Policy;
  readonly name: string;
  readonly nameSpan: Span;
  readonly model: string;
  readonly modelSpan: Span;
  readonly restrict: Expr;
  readonly span: Span;
}

export type AssertExpectation =
  | { readonly kind: "eq"; readonly value: number }
  | { readonly kind: "between"; readonly lo: number; readonly hi: number };

export interface AssertDecl {
  readonly kind: NodeKind.Assert;
  readonly metric: MetricSelect;
  readonly where?: Expr;
  readonly expectation: AssertExpectation;
  readonly span: Span;
}

export interface MaterializeDecl {
  readonly kind: NodeKind.Materialize;
  readonly name: string;
  readonly nameSpan: Span;
  readonly serves: boolean;
  readonly query: QueryDecl;
  readonly span: Span;
}

export interface FunnelStep {
  readonly name: string;
  readonly nameSpan: Span;
  readonly cond: Expr;
}

export interface FunnelDecl {
  readonly kind: NodeKind.Funnel;
  readonly model: string;
  readonly modelSpan: Span;
  readonly entity: RefExpr;
  readonly time: RefExpr;
  readonly steps: FunnelStep[];
  readonly span: Span;
}

export interface RetentionDecl {
  readonly kind: NodeKind.Retention;
  readonly model: string;
  readonly modelSpan: Span;
  readonly entity: RefExpr;
  readonly time: RefExpr;
  readonly periods: number;
  readonly periodsSpan: Span;
  readonly span: Span;
}

export interface Program {
  readonly models: ModelDecl[];
  readonly policies: PolicyDecl[];
  readonly asserts: AssertDecl[];
  readonly materializes: MaterializeDecl[];
}
