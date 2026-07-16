import {
  AggOverride,
  DimensionDecl,
  Expr,
  JoinDecl,
  MeasureDecl,
  MetricDecl,
  ModelDecl,
  NodeKind,
  PolicyDecl,
  RefExpr,
  SegmentDecl
} from "../ast/nodes.js";
import { Unit } from "../config/units.js";
import { ASOF_ORDER, Cardinality, CARDINALITIES, CmpOp, DIM_TYPES, DimType, FANOUT_CARDINALITIES } from "../config/constants.js";
import { AsOfClause } from "../ast/nodes.js";
import { closestName, DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Span } from "../lexer/token.js";
import { AsOfInfo, ColRef } from "./ir.js";

export interface DimInfo {
  readonly name: string;
  readonly type: DimType;
  readonly expr: Expr;
  readonly span: Span;
}

export interface MeasureInfo {
  readonly name: string;
  readonly model: string;
  readonly expr: Expr;
  readonly unit?: Unit;
  readonly additivity?: AggOverride;
  readonly span: Span;
}

export interface MetricInfo {
  readonly name: string;
  readonly model: string;
  readonly expr: Expr;
  readonly filter?: Expr;
  readonly span: Span;
}

export interface JoinInfo {
  readonly fromModel: string;
  readonly target: string;
  readonly left: ColRef;
  readonly op: CmpOp;
  readonly right: ColRef;
  readonly asof?: AsOfInfo;
  readonly cardinality: Cardinality;
  readonly span: Span;
}

export interface SegmentInfo {
  readonly name: string;
  readonly model: string;
  readonly expr: Expr;
  readonly span: Span;
}

export interface ModelInfo {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: string;
  readonly dims: Map<string, DimInfo>;
  readonly measures: Map<string, MeasureInfo>;
  readonly metrics: Map<string, MetricInfo>;
  readonly segments: Map<string, SegmentInfo>;
  readonly joins: JoinInfo[];
  readonly span: Span;
}

const CMP_TEXT_TO_OP: ReadonlyMap<string, CmpOp> = new Map([
  ["=", CmpOp.Eq],
  ["!=", CmpOp.Neq],
  ["<", CmpOp.Lt],
  ["<=", CmpOp.Lte],
  [">", CmpOp.Gt],
  [">=", CmpOp.Gte]
]);

export interface PolicyInfo {
  readonly name: string;
  readonly model: string;
  readonly restrict: Expr;
  readonly span: Span;
}

export class Catalog {
  public readonly models = new Map<string, ModelInfo>();
  public readonly metricIndex = new Map<string, string[]>();
  public readonly measureIndex = new Map<string, string[]>();
  public readonly policies = new Map<string, PolicyInfo[]>();

  public static build(decls: ModelDecl[], policies: PolicyDecl[] = []): Catalog {
    const catalog = new Catalog();
    for (const decl of decls) catalog.addModel(decl);
    for (const decl of decls) catalog.linkJoins(decl);
    for (const policy of policies) catalog.addPolicy(policy);
    return catalog;
  }

  public policiesFor(model: string): PolicyInfo[] {
    return this.policies.get(model) ?? [];
  }

  private addPolicy(policy: PolicyDecl): void {
    this.getModel(policy.model, policy.modelSpan);
    const list = this.policies.get(policy.model);
    const info: PolicyInfo = { name: policy.name, model: policy.model, restrict: policy.restrict, span: policy.span };
    if (list === undefined) this.policies.set(policy.model, [info]);
    else list.push(info);
  }

  public getModel(name: string, span?: Span): ModelInfo {
    const model = this.models.get(name);
    if (model === undefined) {
      throw new SemError(
        DiagCode.UnknownModel,
        `unknown model '${name}'`,
        span,
        closest(name, this.models.keys())
      );
    }
    return model;
  }

  public hasModel(name: string): boolean {
    return this.models.has(name);
  }

  private addModel(decl: ModelDecl): void {
    if (this.models.has(decl.name)) {
      throw new SemError(DiagCode.DuplicateName, `model '${decl.name}' is defined more than once`, decl.nameSpan);
    }
    const dims = new Map<string, DimInfo>();
    for (const dim of decl.dimensions) this.addDimension(decl, dim, dims);

    const measures = new Map<string, MeasureInfo>();
    for (const measure of decl.measures) this.addMeasure(decl, measure, measures);

    const metrics = new Map<string, MetricInfo>();
    for (const metric of decl.metrics) this.addMetric(decl, metric, measures, metrics);

    const segments = new Map<string, SegmentInfo>();
    for (const segment of decl.segments) this.addSegment(decl, segment, dims, measures, metrics, segments);

    this.models.set(decl.name, {
      name: decl.name,
      table: decl.table,
      primaryKey: decl.primaryKey,
      dims,
      measures,
      metrics,
      segments,
      joins: [],
      span: decl.span
    });
  }

  private addSegment(
    decl: ModelDecl,
    segment: SegmentDecl,
    dims: Map<string, DimInfo>,
    measures: Map<string, MeasureInfo>,
    metrics: Map<string, MetricInfo>,
    segments: Map<string, SegmentInfo>
  ): void {
    if (segments.has(segment.name) || dims.has(segment.name) || measures.has(segment.name) || metrics.has(segment.name)) {
      throw new SemError(
        DiagCode.DuplicateName,
        `name '${segment.name}' is defined more than once in model '${decl.name}'`,
        segment.nameSpan
      );
    }
    segments.set(segment.name, { name: segment.name, model: decl.name, expr: segment.expr, span: segment.nameSpan });
  }

  private addDimension(decl: ModelDecl, dim: DimensionDecl, dims: Map<string, DimInfo>): void {
    if (dims.has(dim.name)) {
      throw new SemError(
        DiagCode.DuplicateName,
        `dimension '${dim.name}' is defined more than once in model '${decl.name}'`,
        dim.nameSpan
      );
    }
    if (!DIM_TYPES.has(dim.dimType)) {
      throw new SemError(
        DiagCode.TypeMismatch,
        `unknown dimension type '${dim.dimType}'`,
        dim.dimTypeSpan,
        closest(dim.dimType, DIM_TYPES)
      );
    }
    dims.set(dim.name, { name: dim.name, type: dim.dimType as DimType, expr: dim.expr, span: dim.nameSpan });
  }

  private addMeasure(decl: ModelDecl, measure: MeasureDecl, measures: Map<string, MeasureInfo>): void {
    if (measures.has(measure.name)) {
      throw new SemError(
        DiagCode.DuplicateName,
        `measure '${measure.name}' is defined more than once in model '${decl.name}'`,
        measure.nameSpan
      );
    }
    measures.set(measure.name, {
      name: measure.name,
      model: decl.name,
      expr: measure.expr,
      unit: measure.unit,
      additivity: measure.additivity,
      span: measure.nameSpan
    });
    index(this.measureIndex, measure.name, decl.name);
  }

  private addMetric(
    decl: ModelDecl,
    metric: MetricDecl,
    measures: Map<string, MeasureInfo>,
    metrics: Map<string, MetricInfo>
  ): void {
    if (metrics.has(metric.name) || measures.has(metric.name)) {
      throw new SemError(
        DiagCode.DuplicateName,
        `name '${metric.name}' is defined more than once in model '${decl.name}'`,
        metric.nameSpan
      );
    }
    metrics.set(metric.name, {
      name: metric.name,
      model: decl.name,
      expr: metric.expr,
      filter: metric.filter,
      span: metric.nameSpan
    });
    index(this.metricIndex, metric.name, decl.name);
  }

  private linkJoins(decl: ModelDecl): void {
    const model = this.models.get(decl.name)!;
    for (const join of decl.joins) {
      model.joins.push(this.buildJoin(decl.name, join));
    }
  }

  private buildJoin(fromModel: string, join: JoinDecl): JoinInfo {
    this.getModel(join.target, join.targetSpan);
    if (!CARDINALITIES.has(join.cardinality)) {
      throw new SemError(
        DiagCode.ParseError,
        `unknown cardinality '${join.cardinality}'`,
        join.span,
        closest(join.cardinality, CARDINALITIES)
      );
    }
    const op = CMP_TEXT_TO_OP.get(join.op);
    if (op === undefined) {
      throw new SemError(DiagCode.ParseError, `invalid join operator '${join.op}'`, join.span);
    }
    const left = this.joinSide(fromModel, join.left, fromModel, join.target, join.span);
    const right = this.joinSide(join.target, join.right, fromModel, join.target, join.span);
    const from = left.model === fromModel ? left : right;
    const to = left.model === fromModel ? right : left;
    return {
      fromModel,
      target: join.target,
      left: from,
      op,
      right: to,
      asof: join.asof !== undefined ? this.buildAsOf(fromModel, join, join.asof) : undefined,
      cardinality: join.cardinality as Cardinality,
      span: join.span
    };
  }

  private buildAsOf(fromModel: string, join: JoinDecl, clause: AsOfClause): AsOfInfo {
    if (FANOUT_CARDINALITIES.has(join.cardinality as Cardinality)) {
      throw new SemError(DiagCode.InvalidDefinition, `asof join '${join.target}' must be many_to_one or one_to_one, not '${join.cardinality}'`, clause.span);
    }
    const op = CMP_TEXT_TO_OP.get(clause.op);
    if (op === undefined || !ASOF_ORDER.has(op)) {
      throw new SemError(DiagCode.InvalidDefinition, `asof match must compare timestamps with <, <=, > or >=`, clause.span);
    }
    const left = this.joinSide(fromModel, clause.left, fromModel, join.target, clause.span);
    const right = this.joinSide(join.target, clause.right, fromModel, join.target, clause.span);
    if (left.model !== fromModel || right.model !== join.target) {
      throw new SemError(
        DiagCode.InvalidDefinition,
        `asof match must read the fact timestamp on the left and '${join.target}' on the right`,
        clause.span
      );
    }
    return { left, op, right };
  }

  private joinSide(preferred: string, ref: RefExpr, fromModel: string, target: string, span: Span): ColRef {
    if (ref.kind === NodeKind.Ident) {
      return { model: preferred, column: ref.name };
    }
    const owner = ref.object.kind === NodeKind.Ident ? ref.object.name : "";
    if (owner !== fromModel && owner !== target) {
      throw new SemError(
        DiagCode.UnreachableJoin,
        `join column '${owner}.${ref.name}' does not belong to '${fromModel}' or '${target}'`,
        span
      );
    }
    return { model: owner, column: ref.name };
  }
}

function index(map: Map<string, string[]>, key: string, model: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [model]);
  else list.push(model);
}

function closest(target: string, candidates: Iterable<string>): string | undefined {
  return closestName(target, candidates);
}
