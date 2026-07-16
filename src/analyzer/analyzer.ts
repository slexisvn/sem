import {
  AggOverride,
  BetweenExpr,
  BinaryExpr,
  BinaryOp,
  CallExpr,
  Expr,
  FunnelDecl,
  InExpr,
  RetentionDecl,
  LiteralExpr,
  MetricSelect,
  NodeKind,
  QueryDecl,
  RefExpr,
  TransformCall
} from "../ast/nodes.js";
import {
  AGG_FUNCS,
  AggFunc,
  ArithOp,
  Cardinality,
  CmpOp,
  DimType,
  DURATION_UNIT_DAYS,
  FANOUT_CARDINALITIES,
  GRAIN_DAYS,
  GRAIN_PERIODS_PER_YEAR,
  PERIOD_TO_DATE_GRAIN,
  TIME_GRAINS,
  TimeGrain,
  TransformKind,
  TRANSFORM_NAMES
} from "../config/constants.js";
import { aggAllowsDistinct, aggReAgg, aggTakesParameter, ReAgg } from "../config/aggregates.js";
import { Additivity, fromReAgg, NON_ADDITIVE, windowReduce } from "../config/additivity.js";
import { Unit } from "../config/units.js";
import { typeOf } from "./metric-type.js";
import { closestName, DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Span } from "../lexer/token.js";
import { Catalog, DimInfo, JoinInfo, MeasureInfo, ModelInfo } from "./catalog.js";
import {
  ColExpr,
  ColRef,
  columnModelOf,
  Cond,
  DimPlan,
  FactPlan,
  FunnelPlan,
  RetentionPlan,
  hasSemiAdditive,
  JoinEdge,
  MetricCond,
  MExpr,
  modelSet,
  Plan,
  SelectMetric,
  TransformIR,
  ValueRef
} from "./ir.js";

export interface AnalyzeOptions {
  readonly policies?: readonly string[];
}

interface WorkingSelect {
  readonly name: string;
  readonly baseName: string;
  readonly expr: MExpr;
  readonly raw?: TransformCall;
}

const INVERSE_CARDINALITY: ReadonlyMap<Cardinality, Cardinality> = new Map([
  [Cardinality.ManyToOne, Cardinality.OneToMany],
  [Cardinality.OneToMany, Cardinality.ManyToOne],
  [Cardinality.OneToOne, Cardinality.OneToOne],
  [Cardinality.ManyToMany, Cardinality.ManyToMany]
]);

const ARITH_OPS: ReadonlyMap<BinaryOp, ArithOp> = new Map([
  ["+", ArithOp.Add],
  ["-", ArithOp.Sub],
  ["*", ArithOp.Mul],
  ["/", ArithOp.Div]
]);

const CMP_OPS: ReadonlyMap<BinaryOp, CmpOp> = new Map([
  ["=", CmpOp.Eq],
  ["!=", CmpOp.Neq],
  ["<", CmpOp.Lt],
  ["<=", CmpOp.Lte],
  [">", CmpOp.Gt],
  [">=", CmpOp.Gte]
]);

type DeclKind = "measure" | "metric";

interface Located {
  readonly kind: DeclKind;
  readonly model: string;
  readonly name: string;
  readonly expr: Expr;
  readonly span: Span;
  readonly filter?: Expr;
  readonly unit?: Unit;
  readonly additivity?: AggOverride;
}

interface OperandResult {
  readonly colExpr: ColExpr;
  readonly type?: DimType;
}

type CondResolver = (ref: RefExpr) => OperandResult;

interface DimResolution {
  readonly colExpr: ColExpr;
  readonly type: DimType;
  readonly grain?: TimeGrain;
  readonly outputName: string;
}

interface PathResult {
  readonly edges: JoinEdge[];
  readonly fanOut: boolean;
}

export class Analyzer {
  private readonly catalog: Catalog;
  private readonly cache = new Map<string, MExpr>();
  private readonly adjacency: Map<string, JoinInfo[]>;

  constructor(catalog: Catalog) {
    this.catalog = catalog;
    this.adjacency = this.buildAdjacency();
  }

  public analyze(query: QueryDecl, options: AnalyzeOptions = {}): Plan {
    const working = query.metrics.map((item) => this.resolveSelect(item));
    const facts = this.contributingFacts(working, query.span);
    const strategy = facts.length === 1 ? "single" : "multi";
    const windowed = working.some((s) => s.raw !== undefined);

    const dims = query.dimensions.map((ref) => this.resolveDimension(facts, ref));
    const selects = working.map((w) => this.finishSelect(w, dims, strategy));
    const fannedOut = facts.some((fact) => fact.fannedOut === true);

    if (selects.some((s) => hasSemiAdditive(s.expr)) && (strategy !== "single" || windowed || fannedOut)) {
      throw new SemError(
        DiagCode.Unsupported,
        "semi-additive measures are only supported in single-fact, non-windowed queries without a fan-out dimension",
        query.span
      );
    }

    for (const fact of facts) {
      fact.filter = this.buildFilter(fact, query.where, options);
    }

    let having: MetricCond | undefined;
    if (query.having !== undefined) {
      if (strategy === "multi" || windowed || fannedOut) {
        throw new SemError(
          DiagCode.Unsupported,
          "'having' is only supported for a single-fact, non-windowed query without a fan-out dimension",
          query.span
        );
      }
      having = this.resolveMetricCond(query.having);
    }

    const selectNames = new Set(selects.map((s) => s.name));
    let orderBy: Plan["orderBy"];
    if (query.orderBy !== undefined) {
      const name = this.selectName(query.orderBy.metric);
      if (!selectNames.has(name)) {
        throw new SemError(
          DiagCode.UnknownMetric,
          `'order by' refers to '${name}', which is not one of the shown metrics`,
          query.orderBy.metric.span,
          closestName(name, selectNames)
        );
      }
      orderBy = { name, dir: query.orderBy.dir };
    }

    return {
      strategy,
      windowed,
      facts,
      dims,
      selects,
      orderBy,
      limit: query.top,
      having
    };
  }

  public analyzeFunnel(decl: FunnelDecl): FunnelPlan {
    if (!this.catalog.models.has(decl.model)) {
      throw new SemError(DiagCode.UnknownModel, `unknown model '${decl.model}'`, decl.modelSpan, closestName(decl.model, new Set(this.catalog.models.keys())));
    }
    if (decl.steps.length < 2) {
      throw new SemError(DiagCode.InvalidDefinition, "a funnel needs at least two steps", decl.span);
    }
    const seen = new Set<string>();
    for (const step of decl.steps) {
      if (seen.has(step.name)) {
        throw new SemError(DiagCode.DuplicateName, `duplicate funnel step '${step.name}'`, step.nameSpan);
      }
      seen.add(step.name);
    }
    const resolver = this.columnResolver(decl.model);
    return {
      model: decl.model,
      entity: this.funnelColumn(decl.model, decl.entity, "entity key"),
      time: this.funnelColumn(decl.model, decl.time, "time column"),
      steps: decl.steps.map((step) => ({
        name: step.name,
        cond: this.resolveCond(this.expandSegments(decl.model, step.cond, new Set()), resolver)
      }))
    };
  }

  private funnelColumn(model: string, ref: RefExpr, role: string): ColRef {
    if (ref.kind !== NodeKind.Ident) {
      throw new SemError(DiagCode.TypeMismatch, `the funnel ${role} must be a plain column of '${model}'`, ref.span);
    }
    return { model, column: ref.name };
  }

  public analyzeRetention(decl: RetentionDecl): RetentionPlan {
    if (!this.catalog.models.has(decl.model)) {
      throw new SemError(DiagCode.UnknownModel, `unknown model '${decl.model}'`, decl.modelSpan, closestName(decl.model, new Set(this.catalog.models.keys())));
    }
    if (!Number.isInteger(decl.periods) || decl.periods < 1) {
      throw new SemError(DiagCode.InvalidDefinition, "retention needs a whole number of periods of at least one", decl.periodsSpan);
    }
    const time = this.retentionTime(decl.model, decl.time);
    return {
      model: decl.model,
      entity: this.funnelColumn(decl.model, decl.entity, "entity key"),
      time: time.column,
      grain: time.grain,
      periods: decl.periods
    };
  }

  private retentionTime(model: string, ref: RefExpr): { column: ColRef; grain: TimeGrain } {
    if (ref.kind !== NodeKind.Member || ref.object.kind !== NodeKind.Ident) {
      throw new SemError(DiagCode.TypeMismatch, `retention needs a time grain, e.g. 'occurred_at.month'`, ref.span);
    }
    if (!TIME_GRAINS.has(ref.name)) {
      throw new SemError(DiagCode.UnknownGrain, `unknown time grain '${ref.name}'`, ref.nameSpan, closestName(ref.name, TIME_GRAINS));
    }
    return { column: { model, column: ref.object.name }, grain: ref.name as TimeGrain };
  }

  private buildFilter(fact: FactPlan, where: Expr | undefined, options: AnalyzeOptions): Cond | undefined {
    const parts: Cond[] = [];
    const resolver = this.dimResolver(fact);
    for (const policy of this.catalog.policiesFor(fact.model)) {
      if (options.policies !== undefined && !options.policies.includes(policy.name)) continue;
      parts.push(this.resolveCond(this.expandSegments(fact.model, policy.restrict, new Set()), resolver));
    }
    if (where !== undefined) parts.push(this.resolveCond(this.expandSegments(fact.model, where, new Set()), resolver));
    if (parts.length === 0) return undefined;
    return parts.reduce((left, right) => ({ k: "and", left, right }));
  }

  private expandSegments(model: string, expr: Expr, visiting: Set<string>): Expr {
    switch (expr.kind) {
      case NodeKind.Ident: {
        const segment = this.catalog.models.get(model)?.segments.get(expr.name);
        return segment === undefined ? expr : this.expandSegmentBody(model, expr.name, segment.expr, expr.span, visiting);
      }
      case NodeKind.Member: {
        if (expr.object.kind === NodeKind.Ident && this.catalog.hasModel(expr.object.name)) {
          const segment = this.catalog.models.get(expr.object.name)?.segments.get(expr.name);
          if (segment !== undefined) {
            return this.expandSegmentBody(expr.object.name, expr.name, segment.expr, expr.span, visiting);
          }
        }
        return expr;
      }
      case NodeKind.Binary:
        return { ...expr, left: this.expandSegments(model, expr.left, visiting), right: this.expandSegments(model, expr.right, visiting) };
      case NodeKind.Unary:
        return { ...expr, operand: this.expandSegments(model, expr.operand, visiting) };
      case NodeKind.Between:
        return {
          ...expr,
          value: this.expandSegments(model, expr.value, visiting),
          lower: this.expandSegments(model, expr.lower, visiting),
          upper: this.expandSegments(model, expr.upper, visiting)
        };
      case NodeKind.In:
        return {
          ...expr,
          value: this.expandSegments(model, expr.value, visiting),
          list: expr.list.map((item) => this.expandSegments(model, item, visiting))
        };
      default:
        return expr;
    }
  }

  private expandSegmentBody(model: string, name: string, body: Expr, span: Span, visiting: Set<string>): Expr {
    const key = `${model}:${name}`;
    if (visiting.has(key)) {
      throw new SemError(DiagCode.CyclicMetric, `segment '${name}' is defined in terms of itself`, span);
    }
    visiting.add(key);
    const expanded = this.expandSegments(model, body, visiting);
    visiting.delete(key);
    return expanded;
  }

  private resolveSelect(item: MetricSelect): WorkingSelect {
    const expr = this.expandQueryRef(item.base);
    return { name: this.selectName(item), baseName: item.base.name, expr, raw: item.transform };
  }

  private selectName(item: MetricSelect): string {
    return item.transform === undefined ? item.base.name : `${item.base.name}_${item.transform.name}`;
  }

  private finishSelect(w: WorkingSelect, dims: DimPlan[], strategy: string): SelectMetric {
    if (w.raw === undefined) {
      return { name: w.name, baseName: w.baseName, expr: w.expr };
    }
    if (strategy !== "single") {
      throw new SemError(
        DiagCode.Unsupported,
        "metric transforms are only supported for single-fact queries in phase 2",
        w.raw.span
      );
    }
    const transform = this.buildTransform(w.raw, dims, w.expr);
    return { name: w.name, baseName: w.baseName, expr: w.expr, transform };
  }

  private buildTransform(call: TransformCall, dims: DimPlan[], base: MExpr): TransformIR {
    const kind = call.name as TransformKind;
    switch (kind) {
      case TransformKind.Mom:
        return { kind, lag: 1, orderDim: this.orderDim(dims, call), partition: this.seriesPartition(dims, call) };
      case TransformKind.Yoy:
        return { kind, lag: this.periodsPerYear(dims, call), orderDim: this.orderDim(dims, call), partition: this.seriesPartition(dims, call) };
      case TransformKind.Rolling:
        return { kind, rows: this.rollingRows(call, dims), orderDim: this.orderDim(dims, call), combinator: this.windowCombinator(base, call), partition: this.seriesPartition(dims, call) };
      case TransformKind.Cumulative:
        return { kind, orderDim: this.orderDim(dims, call), combinator: this.windowCombinator(base, call), partition: this.seriesPartition(dims, call) };
      case TransformKind.Mtd:
      case TransformKind.Qtd:
      case TransformKind.Ytd:
        return this.buildPeriodToDate(kind, call, dims, base);
      case TransformKind.Share:
        this.requireAdditive(base, call, ReAgg.Sum, "share() sums the base across a partition");
        return { kind, partition: this.dimPartition(call, dims) };
      case TransformKind.Of:
        return { kind, combinator: this.windowCombinator(base, call), partition: this.dimPartition(call, dims) };
      default:
        throw new SemError(DiagCode.Unsupported, `unknown transform '${call.name}'`, call.nameSpan, closestName(call.name, TRANSFORM_NAMES));
    }
  }

  private buildPeriodToDate(
    kind: TransformKind.Mtd | TransformKind.Qtd | TransformKind.Ytd,
    call: TransformCall,
    dims: DimPlan[],
    base: MExpr
  ): TransformIR {
    const periodGrain = PERIOD_TO_DATE_GRAIN.get(kind)!;
    const grainDim = this.timeGrainDim(dims, call);
    if (GRAIN_DAYS.get(grainDim.grain!)! >= GRAIN_DAYS.get(periodGrain)!) {
      throw new SemError(
        DiagCode.TypeMismatch,
        `transform '.${call.name}' needs a time grain finer than '${periodGrain}' in 'by'; got '${grainDim.grain}'`,
        call.span
      );
    }
    return {
      kind,
      orderDim: grainDim.outputName,
      combinator: this.windowCombinator(base, call),
      partition: this.seriesPartition(dims, call),
      periodGrain
    };
  }

  private seriesPartition(dims: DimPlan[], call: TransformCall): string[] {
    const order = this.orderDim(dims, call);
    return dims.filter((dim) => dim.outputName !== order).map((dim) => dim.outputName);
  }

  private windowCombinator(base: MExpr, call: TransformCall): ReAgg {
    const reduce = windowReduce(typeOf(base, call.span).add);
    if (reduce === ReAgg.None) {
      throw new SemError(
        DiagCode.NonAdditive,
        `transform '.${call.name}' re-aggregates its base over a window, so the base must be additive (sum, count, min, or max); this metric is not`,
        call.span
      );
    }
    return reduce;
  }

  private requireAdditive(base: MExpr, call: TransformCall, need: ReAgg, why: string): void {
    if (windowReduce(typeOf(base, call.span).add) !== need) {
      throw new SemError(
        DiagCode.NonAdditive,
        `transform '.${call.name}' is not valid here: ${why}, which requires a ${need}-additive base metric`,
        call.span
      );
    }
  }

  private timeGrainDim(dims: DimPlan[], call: TransformCall): DimPlan {
    const timeDims = dims.filter((d) => d.grain !== undefined);
    if (timeDims.length === 0) {
      throw new SemError(
        DiagCode.TypeMismatch,
        `transform '.${call.name}' needs a time-grain dimension in 'by' (e.g. 'by ordered_at.month')`,
        call.span
      );
    }
    if (timeDims.length > 1) {
      throw new SemError(DiagCode.AmbiguousReference, `transform '.${call.name}' is ambiguous with multiple time grains`, call.span);
    }
    return timeDims[0]!;
  }

  private orderDim(dims: DimPlan[], call: TransformCall): string {
    return this.timeGrainDim(dims, call).outputName;
  }

  private periodsPerYear(dims: DimPlan[], call: TransformCall): number {
    return GRAIN_PERIODS_PER_YEAR.get(this.timeGrainDim(dims, call).grain!)!;
  }

  private rollingRows(call: TransformCall, dims: DimPlan[]): number {
    const grain = this.timeGrainDim(dims, call).grain!;
    if (call.args.length !== 1 || call.args[0]!.kind !== "duration") {
      throw new SemError(DiagCode.TypeMismatch, "rolling() expects a single duration such as 7d or 30d", call.span);
    }
    const days = parseDurationDays(call.args[0]!.text, call.span);
    const grainDays = GRAIN_DAYS.get(grain)!;
    return Math.max(1, Math.round(days / grainDays));
  }

  private dimPartition(call: TransformCall, dims: DimPlan[]): string[] {
    const partition: string[] = [];
    for (const arg of call.args) {
      if (arg.kind !== "dim") {
        throw new SemError(DiagCode.TypeMismatch, `${call.name}() partitions by dimensions, not a duration`, arg.span);
      }
      const name = arg.ref.name;
      const dim = dims.find((d) => d.outputName === name);
      if (dim === undefined) {
        throw new SemError(
          DiagCode.UnknownDimension,
          `${call.name}(${name}) partitions by '${name}', which is not one of the 'by' dimensions`,
          arg.span,
          closestName(name, dims.map((d) => d.outputName))
        );
      }
      partition.push(dim.outputName);
    }
    return partition;
  }

  private contributingFacts(selects: readonly { readonly expr: MExpr }[], span: Span): FactPlan[] {
    const seen = new Set<string>();
    const facts: FactPlan[] = [];
    for (const select of selects) {
      for (const model of modelSet(select.expr)) {
        if (!seen.has(model)) {
          seen.add(model);
          facts.push({ model, joins: [] });
        }
      }
    }
    if (facts.length === 0) {
      throw new SemError(DiagCode.Unsupported, "query has no aggregate metric to compute", span);
    }
    return facts;
  }

  private expandQueryRef(ref: RefExpr): MExpr {
    if (ref.kind === NodeKind.Ident) {
      return this.expandRef(undefined, ref.name, ref.span, new Set());
    }
    if (ref.object.kind !== NodeKind.Ident) {
      throw new SemError(DiagCode.Unsupported, "nested metric references are not supported", ref.span);
    }
    if (this.catalog.hasModel(ref.object.name)) {
      return this.expandRef(ref.object.name, ref.name, ref.span, new Set());
    }
    throw new SemError(
      DiagCode.Unsupported,
      `metric transforms such as '.${ref.name}' are a phase 2 feature`,
      ref.span
    );
  }

  private expandRef(hint: string | undefined, name: string, span: Span, visiting: Set<string>): MExpr {
    const located = this.locate(hint, name, span);
    return this.expandLocated(located, span, visiting);
  }

  private locate(hint: string | undefined, name: string, span: Span): Located {
    if (hint !== undefined) {
      const model = this.catalog.models.get(hint);
      const metric = model?.metrics.get(name);
      if (metric !== undefined) {
        return { kind: "metric", model: hint, name, expr: metric.expr, filter: metric.filter, span: metric.span };
      }
      const measure = model?.measures.get(name);
      if (measure !== undefined) return this.locatedMeasure(hint, name, measure);
    }
    const metricModels = this.catalog.metricIndex.get(name);
    if (metricModels !== undefined) {
      if (metricModels.length > 1) {
        throw new SemError(
          DiagCode.AmbiguousReference,
          `metric '${name}' is defined in models ${metricModels.join(", ")}; qualify it as 'Model.${name}'`,
          span
        );
      }
      const model = metricModels[0]!;
      const metric = this.catalog.models.get(model)!.metrics.get(name)!;
      return { kind: "metric", model, name, expr: metric.expr, filter: metric.filter, span: metric.span };
    }
    const measureModels = this.catalog.measureIndex.get(name);
    if (measureModels !== undefined) {
      if (measureModels.length > 1) {
        throw new SemError(
          DiagCode.AmbiguousReference,
          `measure '${name}' is defined in models ${measureModels.join(", ")}; qualify it as 'Model.${name}'`,
          span
        );
      }
      const model = measureModels[0]!;
      const measure = this.catalog.models.get(model)!.measures.get(name)!;
      return this.locatedMeasure(model, name, measure);
    }
    throw new SemError(DiagCode.UnknownMetric, `unknown metric '${name}'`, span, this.suggestMetric(name));
  }

  private locatedMeasure(model: string, name: string, measure: MeasureInfo): Located {
    return {
      kind: "measure",
      model,
      name,
      expr: measure.expr,
      span: measure.span,
      unit: measure.unit,
      additivity: measure.additivity
    };
  }

  private expandLocated(located: Located, span: Span, visiting: Set<string>): MExpr {
    const key = `${located.model}:${located.name}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) {
      throw new SemError(DiagCode.CyclicMetric, `${located.kind} '${located.name}' is defined in terms of itself`, span);
    }
    visiting.add(key);
    const body = this.expandExpr(located.model, located.expr, located.kind, visiting);
    const filtered = located.filter !== undefined ? this.attachFilter(body, located.filter) : body;
    const result = located.kind === "measure" ? this.annotateMeasure(located, filtered) : filtered;
    visiting.delete(key);
    this.checkShape(located, result, span);
    typeOf(result, located.span);
    this.cache.set(key, result);
    return result;
  }

  private annotateMeasure(located: Located, node: MExpr): MExpr {
    if (node.k !== "agg") return node;
    const override = located.additivity;
    if (override === undefined) return { ...node, unit: located.unit };
    if (override.kind === "non_additive") return { ...node, unit: located.unit, add: NON_ADDITIVE };
    const inferred = fromReAgg(aggReAgg(node.func, node.distinct));
    if (inferred.kind !== "additive") {
      throw new SemError(
        DiagCode.InvalidDefinition,
        `measure '${located.name}' cannot be semi-additive because '${node.func}' does not aggregate additively`,
        override.span
      );
    }
    const semiCol = this.resolveModelDimColumn(located.model, override.dim, override.dimSpan);
    const add: Additivity = { kind: "semi", reduce: inferred.reduce, rule: override.rule };
    return { ...node, unit: located.unit, add, semiCol };
  }

  private resolveModelDimColumn(model: string, dim: string, span: Span): ColExpr {
    const info = this.catalog.models.get(model)!;
    const dimInfo = info.dims.get(dim);
    if (dimInfo === undefined) {
      throw new SemError(
        DiagCode.UnknownDimension,
        `semi-additive dimension '${dim}' is not a dimension of model '${model}'`,
        span,
        closestName(dim, info.dims.keys())
      );
    }
    return this.resolveColExpr(model, dimInfo.expr);
  }

  private checkShape(located: Located, result: MExpr, span: Span): void {
    if (located.kind === "measure") {
      if (result.k !== "agg") {
        throw new SemError(
          DiagCode.InvalidDefinition,
          `measure '${located.name}' must be a single aggregate over its own columns; compose measures in a 'metric' instead`,
          span
        );
      }
      if (result.model !== located.model) {
        throw new SemError(
          DiagCode.InvalidDefinition,
          `measure '${located.name}' must aggregate its own model's columns, not '${result.model}'; define that measure on '${result.model}'`,
          span
        );
      }
    }
    if (located.kind === "metric" && !hasAggregate(result)) {
      throw new SemError(
        DiagCode.InvalidDefinition,
        `metric '${located.name}' must build on at least one measure`,
        span
      );
    }
  }

  private attachFilter(node: MExpr, filter: Expr): MExpr {
    switch (node.k) {
      case "agg": {
        const expanded = this.expandSegments(node.model, filter, new Set());
        const cond = this.resolveCond(expanded, this.columnResolver(node.model));
        const merged: Cond = node.filter !== undefined ? { k: "and", left: node.filter, right: cond } : cond;
        return { ...node, filter: merged };
      }
      case "bin":
        return { k: "bin", op: node.op, left: this.attachFilter(node.left, filter), right: this.attachFilter(node.right, filter) };
      case "num":
        return node;
    }
  }

  private expandExpr(model: string, expr: Expr, owner: DeclKind, visiting: Set<string>): MExpr {
    switch (expr.kind) {
      case NodeKind.Literal: {
        if (expr.literalType !== "number") {
          throw new SemError(DiagCode.TypeMismatch, "only numeric literals are allowed here", expr.span);
        }
        return { k: "num", value: expr.value as number };
      }
      case NodeKind.Call: {
        if (owner === "metric") {
          throw new SemError(
            DiagCode.InvalidDefinition,
            `a metric cannot call an aggregate like '${expr.callee}' directly; define a measure and reference it`,
            expr.calleeSpan
          );
        }
        return this.expandCall(model, expr);
      }
      case NodeKind.Ident:
        this.requireComposable(owner, expr.name, expr.span);
        return this.expandRef(model, expr.name, expr.span, visiting);
      case NodeKind.Member: {
        if (expr.object.kind !== NodeKind.Ident || !this.catalog.hasModel(expr.object.name)) {
          throw new SemError(DiagCode.Unsupported, `unsupported reference '${refName(expr)}'`, expr.span);
        }
        this.requireComposable(owner, expr.name, expr.span);
        return this.expandRef(expr.object.name, expr.name, expr.span, visiting);
      }
      case NodeKind.Binary: {
        const op = ARITH_OPS.get(expr.op);
        if (op === undefined) {
          throw new SemError(DiagCode.TypeMismatch, `operator '${expr.op}' is not valid here`, expr.span);
        }
        return {
          k: "bin",
          op,
          left: this.expandExpr(model, expr.left, owner, visiting),
          right: this.expandExpr(model, expr.right, owner, visiting)
        };
      }
      case NodeKind.Unary: {
        if (expr.op !== "-") {
          throw new SemError(DiagCode.TypeMismatch, "'not' is not valid here", expr.span);
        }
        return {
          k: "bin",
          op: ArithOp.Mul,
          left: { k: "num", value: -1 },
          right: this.expandExpr(model, expr.operand, owner, visiting)
        };
      }
      default:
        throw new SemError(DiagCode.TypeMismatch, "unsupported expression", expr.span);
    }
  }

  private requireComposable(owner: DeclKind, name: string, span: Span): void {
    if (owner === "measure") {
      throw new SemError(
        DiagCode.InvalidDefinition,
        `a measure cannot reference '${name}'; a measure is a single aggregate over its own columns`,
        span
      );
    }
  }

  private expandCall(model: string, expr: CallExpr): MExpr {
    const funcName = expr.callee.toLowerCase();
    if (!AGG_FUNCS.has(funcName)) {
      throw new SemError(
        DiagCode.UnknownAggregate,
        `unknown aggregate function '${expr.callee}'`,
        expr.calleeSpan,
        closestName(funcName, AGG_FUNCS)
      );
    }
    const func = funcName as AggFunc;
    const takesParameter = aggTakesParameter(func);
    const arity = takesParameter ? 2 : 1;
    if (expr.args.length !== arity) {
      const shape = takesParameter ? "a column and a percentile" : "exactly one argument";
      throw new SemError(DiagCode.TypeMismatch, `aggregate '${funcName}' expects ${shape}`, expr.span);
    }
    if (expr.distinct && !aggAllowsDistinct(func)) {
      throw new SemError(DiagCode.TypeMismatch, `aggregate '${funcName}' does not support 'distinct'`, expr.calleeSpan);
    }
    const arg = this.resolveColExpr(model, expr.args[0]!);
    const factModel = this.aggModel(model, arg, expr.span);
    const quantile = takesParameter ? this.percentileFraction(expr.args[1]!) : undefined;
    return { k: "agg", model: factModel, func, arg, distinct: expr.distinct, quantile };
  }

  private percentileFraction(expr: Expr): number {
    if (expr.kind !== NodeKind.Literal || expr.literalType !== "number") {
      throw new SemError(DiagCode.TypeMismatch, "percentile expects a numeric percentile between 0 and 100", expr.span);
    }
    const value = expr.value as number;
    if (value <= 0 || value > 100) {
      throw new SemError(DiagCode.TypeMismatch, `percentile must be between 0 and 100, got ${value}`, expr.span);
    }
    return value / 100;
  }

  private aggModel(declaring: string, arg: ColExpr, span: Span): string {
    const models = columnModelOf(arg);
    if (models.size === 0) return declaring;
    if (models.size > 1) {
      throw new SemError(DiagCode.TypeMismatch, "an aggregate cannot mix columns from different models", span);
    }
    for (const model of models) return model;
    return declaring;
  }

  private resolveColExpr(model: string, expr: Expr): ColExpr {
    switch (expr.kind) {
      case NodeKind.Ident:
        return { k: "col", ref: { model, column: expr.name } };
      case NodeKind.Member: {
        if (expr.object.kind !== NodeKind.Ident) {
          throw new SemError(DiagCode.Unsupported, "nested column references are not supported", expr.span);
        }
        return { k: "col", ref: { model: expr.object.name, column: expr.name } };
      }
      case NodeKind.Literal: {
        if (expr.literalType !== "number") {
          throw new SemError(DiagCode.TypeMismatch, "expected a column or number", expr.span);
        }
        return { k: "num", value: expr.value as number };
      }
      case NodeKind.Binary: {
        const op = ARITH_OPS.get(expr.op);
        if (op === undefined) {
          throw new SemError(DiagCode.TypeMismatch, `operator '${expr.op}' is not valid inside an aggregate`, expr.span);
        }
        return { k: "bin", op, left: this.resolveColExpr(model, expr.left), right: this.resolveColExpr(model, expr.right) };
      }
      case NodeKind.Unary: {
        if (expr.op !== "-") {
          throw new SemError(DiagCode.TypeMismatch, "'not' is not valid inside an aggregate", expr.span);
        }
        return { k: "bin", op: ArithOp.Mul, left: { k: "num", value: -1 }, right: this.resolveColExpr(model, expr.operand) };
      }
      default:
        throw new SemError(DiagCode.TypeMismatch, "unsupported expression inside an aggregate", expr.span);
    }
  }

  private columnResolver(model: string): CondResolver {
    return (ref: RefExpr): OperandResult => ({ colExpr: this.resolveColExpr(model, ref) });
  }

  private dimResolver(fact: FactPlan): CondResolver {
    return (ref: RefExpr): OperandResult => {
      const resolution = this.resolveDim(fact, ref);
      const colExpr =
        resolution.grain !== undefined
          ? ({ k: "trunc", grain: resolution.grain, arg: resolution.colExpr } as ColExpr)
          : resolution.colExpr;
      return { colExpr, type: resolution.type };
    };
  }

  private resolveCond(expr: Expr, resolver: CondResolver): Cond {
    switch (expr.kind) {
      case NodeKind.Binary:
        return this.resolveBinaryCond(expr, resolver);
      case NodeKind.Unary: {
        if (expr.op !== "not") {
          throw new SemError(DiagCode.TypeMismatch, "expected a condition", expr.span);
        }
        return { k: "not", operand: this.resolveCond(expr.operand, resolver) };
      }
      case NodeKind.Between:
        return this.resolveBetween(expr, resolver);
      case NodeKind.In:
        return this.resolveIn(expr, resolver);
      default:
        throw new SemError(DiagCode.TypeMismatch, "expected a condition", expr.span);
    }
  }

  private resolveBinaryCond(expr: BinaryExpr, resolver: CondResolver): Cond {
    if (expr.op === "and") {
      return { k: "and", left: this.resolveCond(expr.left, resolver), right: this.resolveCond(expr.right, resolver) };
    }
    if (expr.op === "or") {
      return { k: "or", left: this.resolveCond(expr.left, resolver), right: this.resolveCond(expr.right, resolver) };
    }
    if (expr.op === "like") {
      const left = this.resolveOperand(expr.left, resolver);
      const pattern = this.expectStringParam(expr.right);
      return { k: "like", left: left.colExpr, pattern };
    }
    const op = CMP_OPS.get(expr.op);
    if (op === undefined) {
      throw new SemError(DiagCode.TypeMismatch, `operator '${expr.op}' is not valid in a condition`, expr.span);
    }
    const left = this.resolveOperand(expr.left, resolver);
    if (expr.right.kind === NodeKind.Literal) {
      const value = this.literalParam(expr.right, left.type);
      return { k: "cmp", op, left: left.colExpr, right: value };
    }
    const right = this.resolveOperand(expr.right, resolver);
    return { k: "cmp", op, left: left.colExpr, right: right.colExpr };
  }

  private resolveBetween(expr: BetweenExpr, resolver: CondResolver): Cond {
    const left = this.resolveOperand(expr.value, resolver);
    return {
      k: "between",
      left: left.colExpr,
      lo: this.literalParam(this.asLiteral(expr.lower), left.type),
      hi: this.literalParam(this.asLiteral(expr.upper), left.type)
    };
  }

  private resolveIn(expr: InExpr, resolver: CondResolver): Cond {
    const left = this.resolveOperand(expr.value, resolver);
    const values = expr.list.map((item) => this.literalParam(this.asLiteral(item), left.type));
    return { k: "in", left: left.colExpr, values };
  }

  private resolveOperand(expr: Expr, resolver: CondResolver): OperandResult {
    if (expr.kind === NodeKind.Ident || expr.kind === NodeKind.Member) {
      return resolver(expr);
    }
    if (expr.kind === NodeKind.Literal && expr.literalType === "number") {
      return { colExpr: { k: "num", value: expr.value as number }, type: DimType.Number };
    }
    throw new SemError(DiagCode.TypeMismatch, "expected a dimension or column here", expr.span);
  }

  private asLiteral(expr: Expr): LiteralExpr {
    if (expr.kind !== NodeKind.Literal) {
      throw new SemError(DiagCode.TypeMismatch, "expected a literal value", expr.span);
    }
    return expr;
  }

  private expectStringParam(expr: Expr): ValueRef {
    const literal = this.asLiteral(expr);
    if (literal.literalType !== "string") {
      throw new SemError(DiagCode.TypeMismatch, "'like' expects a string pattern", literal.span);
    }
    return { k: "param", value: literal.value };
  }

  private literalParam(literal: LiteralExpr, type: DimType | undefined): ValueRef {
    if (type !== undefined) this.checkLiteralType(literal, type);
    return { k: "param", value: literal.value };
  }

  private checkLiteralType(literal: LiteralExpr, type: DimType): void {
    const ok =
      (type === DimType.String && literal.literalType === "string") ||
      (type === DimType.Number && literal.literalType === "number") ||
      (type === DimType.Boolean && literal.literalType === "boolean") ||
      (type === DimType.Time && literal.literalType === "string");
    if (!ok) {
      throw new SemError(
        DiagCode.TypeMismatch,
        `cannot compare a ${type} dimension with a ${literal.literalType} value`,
        literal.span
      );
    }
  }

  private resolveMetricCond(expr: Expr): MetricCond {
    switch (expr.kind) {
      case NodeKind.Binary: {
        if (expr.op === "and") {
          return { k: "and", left: this.resolveMetricCond(expr.left), right: this.resolveMetricCond(expr.right) };
        }
        if (expr.op === "or") {
          return { k: "or", left: this.resolveMetricCond(expr.left), right: this.resolveMetricCond(expr.right) };
        }
        const op = CMP_OPS.get(expr.op);
        if (op === undefined) {
          throw new SemError(DiagCode.TypeMismatch, `operator '${expr.op}' is not valid in 'having'`, expr.span);
        }
        const left = this.metricOperand(expr.left);
        const right = this.literalParam(this.asLiteral(expr.right), undefined);
        return { k: "cmp", op, left, right };
      }
      case NodeKind.Unary: {
        if (expr.op !== "not") {
          throw new SemError(DiagCode.TypeMismatch, "expected a condition in 'having'", expr.span);
        }
        return { k: "not", operand: this.resolveMetricCond(expr.operand) };
      }
      case NodeKind.Between: {
        const left = this.metricOperand(expr.value);
        return {
          k: "between",
          left,
          lo: this.literalParam(this.asLiteral(expr.lower), undefined),
          hi: this.literalParam(this.asLiteral(expr.upper), undefined)
        };
      }
      default:
        throw new SemError(DiagCode.TypeMismatch, "expected a condition in 'having'", expr.span);
    }
  }

  private metricOperand(expr: Expr): MExpr {
    if (expr.kind === NodeKind.Ident || expr.kind === NodeKind.Member) {
      return this.expandQueryRef(expr);
    }
    if (expr.kind === NodeKind.Literal && expr.literalType === "number") {
      return { k: "num", value: expr.value as number };
    }
    if (expr.kind === NodeKind.Binary) {
      const op = ARITH_OPS.get(expr.op);
      if (op !== undefined) {
        return { k: "bin", op, left: this.metricOperand(expr.left), right: this.metricOperand(expr.right) };
      }
    }
    throw new SemError(DiagCode.TypeMismatch, "expected a metric in 'having'", expr.span);
  }

  private resolveDimension(facts: FactPlan[], ref: RefExpr): DimPlan {
    const perFact = new Map<string, ColExpr>();
    let outputName: string | undefined;
    let type: DimType | undefined;
    let grain: TimeGrain | undefined;

    for (const fact of facts) {
      const resolution = this.resolveDim(fact, ref);
      if (outputName === undefined) {
        outputName = resolution.outputName;
        type = resolution.type;
        grain = resolution.grain;
      } else if (type !== resolution.type) {
        throw new SemError(
          DiagCode.TypeMismatch,
          `dimension '${outputName}' has inconsistent types across fact tables`,
          ref.span
        );
      }
      perFact.set(fact.model, resolution.colExpr);
    }

    return { outputName: outputName!, type: type!, grain, perFact };
  }

  private resolveDim(fact: FactPlan, ref: RefExpr): DimResolution {
    return ref.kind === NodeKind.Ident ? this.resolveBareDim(fact, ref.name, ref.span) : this.resolveMemberDim(fact, ref);
  }

  private resolveBareDim(fact: FactPlan, name: string, span: Span): DimResolution {
    const model = this.catalog.models.get(fact.model)!;
    const own = model.dims.get(name);
    if (own !== undefined) {
      return { colExpr: this.dimColumn(fact.model, own), type: own.type, outputName: name };
    }

    const candidates: Array<{ target: string; dim: DimInfo }> = [];
    for (const join of this.adjacency.get(fact.model) ?? []) {
      const dim = this.catalog.models.get(join.target)!.dims.get(name);
      if (dim !== undefined) candidates.push({ target: join.target, dim });
    }

    if (candidates.length === 0) {
      throw new SemError(DiagCode.UnknownDimension, `unknown dimension '${name}'`, span, this.suggestDim(fact.model, name));
    }
    if (candidates.length > 1) {
      const models = candidates.map((c) => c.target).join(", ");
      throw new SemError(
        DiagCode.AmbiguousReference,
        `dimension '${name}' is reachable through ${models}; qualify it as 'Model.${name}'`,
        span
      );
    }

    const only = candidates[0]!;
    this.attachPath(fact, only.target, span);
    return { colExpr: this.dimColumn(only.target, only.dim), type: only.dim.type, outputName: name };
  }

  private resolveMemberDim(fact: FactPlan, ref: Extract<RefExpr, { kind: NodeKind.Member }>): DimResolution {
    if (ref.object.kind !== NodeKind.Ident) {
      throw new SemError(DiagCode.Unsupported, "nested dimension references are not supported", ref.span);
    }
    const head = ref.object.name;

    if (this.catalog.hasModel(head)) {
      const target = this.catalog.getModel(head, ref.object.span);
      const dim = target.dims.get(ref.name);
      if (dim === undefined) {
        throw new SemError(
          DiagCode.UnknownDimension,
          `model '${head}' has no dimension '${ref.name}'`,
          ref.nameSpan,
          closestName(ref.name, target.dims.keys())
        );
      }
      this.attachPath(fact, head, ref.span);
      return { colExpr: this.dimColumn(head, dim), type: dim.type, outputName: ref.name };
    }

    const model = this.catalog.models.get(fact.model)!;
    const baseDim = model.dims.get(head);
    if (baseDim !== undefined) {
      if (!TIME_GRAINS.has(ref.name)) {
        throw new SemError(
          DiagCode.UnknownGrain,
          `unknown time grain '${ref.name}'`,
          ref.nameSpan,
          closestName(ref.name, TIME_GRAINS)
        );
      }
      if (baseDim.type !== DimType.Time) {
        throw new SemError(
          DiagCode.TypeMismatch,
          `time grain '.${ref.name}' requires a time dimension, but '${head}' is ${baseDim.type}`,
          ref.span
        );
      }
      return {
        colExpr: this.dimColumn(fact.model, baseDim),
        type: DimType.Time,
        grain: ref.name as TimeGrain,
        outputName: `${head}_${ref.name}`
      };
    }

    throw new SemError(
      DiagCode.UnknownDimension,
      `unknown model or dimension '${head}'`,
      ref.object.span,
      closestName(head, this.dimNamesFor(fact.model))
    );
  }

  private dimColumn(model: string, dim: DimInfo): ColExpr {
    return this.resolveColExpr(model, dim.expr);
  }

  private attachPath(fact: FactPlan, target: string, span: Span): void {
    const path = this.joinPath(fact.model, target, span);
    if (path.fanOut) fact.fannedOut = true;
    for (const edge of path.edges) this.addJoin(fact, edge);
  }

  private addJoin(fact: FactPlan, edge: JoinEdge): void {
    const exists = fact.joins.some(
      (e) => e.fromModel === edge.fromModel && e.target === edge.target && e.left.column === edge.left.column
    );
    if (!exists) fact.joins.push(edge);
  }

  private joinPath(from: string, to: string, span: Span): PathResult {
    if (from === to) return { edges: [], fanOut: false };

    const dist = new Map<string, number>([[from, 0]]);
    const ways = new Map<string, number>([[from, 1]]);
    const prev = new Map<string, JoinInfo>();
    const queue: string[] = [from];

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const join of this.adjacency.get(node) ?? []) {
        const nd = dist.get(node)! + 1;
        const known = dist.get(join.target);
        if (known === undefined) {
          dist.set(join.target, nd);
          ways.set(join.target, ways.get(node)!);
          prev.set(join.target, join);
          queue.push(join.target);
        } else if (known === nd) {
          ways.set(join.target, ways.get(join.target)! + ways.get(node)!);
        }
      }
    }

    if (!dist.has(to)) {
      throw new SemError(DiagCode.UnreachableJoin, `no join path from '${from}' to '${to}'`, span);
    }
    if (ways.get(to)! > 1) {
      throw new SemError(
        DiagCode.AmbiguousJoin,
        `more than one join path from '${from}' to '${to}'; the model must disambiguate`,
        span
      );
    }

    const edges: JoinEdge[] = [];
    let fanOut = false;
    let cursor = to;
    while (cursor !== from) {
      const join = prev.get(cursor)!;
      if (FANOUT_CARDINALITIES.has(join.cardinality)) fanOut = true;
      edges.push({ fromModel: join.fromModel, target: join.target, left: join.left, op: join.op, right: join.right, asof: join.asof, span: join.span });
      cursor = join.fromModel;
    }
    edges.reverse();
    return { edges, fanOut };
  }

  private buildAdjacency(): Map<string, JoinInfo[]> {
    const adjacency = new Map<string, JoinInfo[]>();
    const push = (from: string, edge: JoinInfo): void => {
      const list = adjacency.get(from);
      if (list === undefined) adjacency.set(from, [edge]);
      else list.push(edge);
    };
    for (const model of this.catalog.models.values()) {
      for (const join of model.joins) {
        push(join.fromModel, join);
        if (join.asof !== undefined) continue;
        push(join.target, {
          fromModel: join.target,
          target: join.fromModel,
          left: join.right,
          op: join.op,
          right: join.left,
          cardinality: INVERSE_CARDINALITY.get(join.cardinality)!,
          span: join.span
        });
      }
    }
    return adjacency;
  }

  private suggestMetric(name: string): string | undefined {
    const names = new Set<string>([...this.catalog.metricIndex.keys(), ...this.catalog.measureIndex.keys()]);
    return closestName(name, names);
  }

  private suggestDim(model: string, name: string): string | undefined {
    return closestName(name, this.dimNamesFor(model));
  }

  private dimNamesFor(model: string): Set<string> {
    const names = new Set<string>();
    const info = this.catalog.models.get(model);
    if (info === undefined) return names;
    for (const dimName of info.dims.keys()) names.add(dimName);
    for (const join of info.joins) {
      const target = this.catalog.models.get(join.target);
      if (target !== undefined) for (const dimName of target.dims.keys()) names.add(dimName);
    }
    return names;
  }
}

function refName(ref: RefExpr): string {
  return ref.name;
}

function hasAggregate(node: MExpr): boolean {
  switch (node.k) {
    case "agg":
      return true;
    case "bin":
      return hasAggregate(node.left) || hasAggregate(node.right);
    case "num":
      return false;
  }
}

function parseDurationDays(text: string, span: Span): number {
  const match = /^(\d+)([a-z]+)$/.exec(text);
  if (match === null) {
    throw new SemError(DiagCode.TypeMismatch, `invalid duration '${text}'`, span);
  }
  const unitDays = DURATION_UNIT_DAYS.get(match[2]!);
  if (unitDays === undefined) {
    throw new SemError(
      DiagCode.TypeMismatch,
      `unknown duration unit '${match[2]}' (use d, w, m, q, or y)`,
      span,
      closestName(match[2]!, DURATION_UNIT_DAYS.keys())
    );
  }
  return Number(match[1]) * unitDays;
}

export function analyze(catalog: Catalog, query: QueryDecl, options?: AnalyzeOptions): Plan {
  return new Analyzer(catalog).analyze(query, options);
}

export function analyzeFunnel(catalog: Catalog, decl: FunnelDecl): FunnelPlan {
  return new Analyzer(catalog).analyzeFunnel(decl);
}

export function analyzeRetention(catalog: Catalog, decl: RetentionDecl): RetentionPlan {
  return new Analyzer(catalog).analyzeRetention(decl);
}

export type { ModelInfo };
