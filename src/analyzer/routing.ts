import { REAGG_FUNC, ReAgg } from "../config/aggregates.js";
import { frameEquals, GRAIN_ROLLUP, TimeFrame, TimeGrain } from "../config/constants.js";
import { NON_ADDITIVE } from "../config/additivity.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Span } from "../lexer/token.js";
import { analyze } from "./analyzer.js";
import { Catalog, MaterializationInfo } from "./catalog.js";
import { typeOf } from "./metric-type.js";
import {
  ColExpr,
  Cond,
  DimPlan,
  MetricCond,
  MExpr,
  OutExpr,
  Plan,
  SelectMetric,
  sigCol,
  sigCond,
  signature
} from "./ir.js";

export interface RoutedPlan {
  readonly plan: Plan;
  readonly materialization: string;
}

interface DimSlot {
  readonly column: string;
  readonly grain?: TimeGrain;
  readonly frame?: TimeFrame;
}

class Candidate {
  private readonly byBase = new Map<string, DimSlot>();
  private readonly byMetric = new Map<string, string>();
  private readonly used = new Set<string>();
  private coarsened = false;

  constructor(private readonly mv: MaterializationInfo, private readonly source: Plan, private readonly span: Span) {
    for (const dim of source.dims) {
      for (const colExpr of dim.perFact.values()) {
        this.byBase.set(sigCol(colExpr), { column: dim.outputName, grain: dim.grain, frame: dim.frame });
      }
    }
    for (const select of source.selects) {
      if (select.out.k === "term" && select.out.transform === undefined) {
        this.byMetric.set(signature(select.out.expr), select.name);
      }
    }
  }

  public route(query: Plan): RoutedPlan | undefined {
    const dims: DimPlan[] = [];
    for (const dim of query.dims) {
      const rewritten = this.rewriteDim(dim);
      if (rewritten === undefined) return undefined;
      dims.push(rewritten);
    }

    const filter = this.mergeFilters(query);
    if (filter === null) return undefined;

    const rollup = this.coarsened || this.used.size < this.source.dims.length;
    if (rollup && this.source.facts.some((fact) => fact.fannedOut === true)) return undefined;

    const selects: SelectMetric[] = [];
    for (const select of query.selects) {
      const out = this.rewriteOut(select.out, rollup);
      if (out === undefined) return undefined;
      selects.push({ name: select.name, out });
    }

    const having = query.having === undefined ? undefined : this.rewriteMetricCond(query.having, rollup);
    if (query.having !== undefined && having === undefined) return undefined;

    return {
      materialization: this.mv.name,
      plan: {
        strategy: "single",
        windowed: query.windowed,
        facts: [{ model: this.mv.name, joins: [], filter: filter ?? undefined }],
        dims,
        selects,
        orderBy: query.orderBy,
        limit: query.limit,
        having
      }
    };
  }

  private rewriteDim(dim: DimPlan): DimPlan | undefined {
    const slots = [...dim.perFact.values()].map((colExpr) => this.byBase.get(sigCol(colExpr)));
    const slot = slots[0];
    if (slot === undefined || slots.some((other) => other?.column !== slot.column)) return undefined;
    if (!bucketReachable(slot, dim.grain, dim.frame)) return undefined;
    this.used.add(slot.column);
    if (slot.grain !== dim.grain) this.coarsened = true;
    return {
      outputName: dim.outputName,
      type: dim.type,
      grain: slot.grain === dim.grain ? undefined : dim.grain,
      frame: carriedFrame(slot, dim.frame),
      perFact: new Map([[this.mv.name, this.column(slot.column)]])
    };
  }

  private mergeFilters(query: Plan): Cond | undefined | null {
    const baked = new Map<string, Set<string>>();
    for (const fact of this.source.facts) {
      baked.set(fact.model, new Set(conjuncts(fact.filter).map(sigCond)));
    }

    const seen = new Set<string>();
    const parts: Cond[] = [];
    for (const fact of query.facts) {
      const already = baked.get(fact.model);
      if (already === undefined) return null;
      const wanted = conjuncts(fact.filter);
      const wantedSigs = new Set(wanted.map(sigCond));
      for (const sig of already) if (!wantedSigs.has(sig)) return null;

      for (const part of wanted) {
        const sig = sigCond(part);
        if (already.has(sig) || seen.has(sig)) continue;
        seen.add(sig);
        const rewritten = this.rewriteCond(part);
        if (rewritten === undefined) return null;
        parts.push(rewritten);
      }
    }
    if (parts.length === 0) return undefined;
    return parts.reduce((left, right) => ({ k: "and", left, right }));
  }

  private rewriteMetricCond(cond: MetricCond, rollup: boolean): MetricCond | undefined {
    switch (cond.k) {
      case "cmp": {
        const left = this.rewriteMExpr(cond.left, rollup);
        return left === undefined ? undefined : { k: "cmp", op: cond.op, left, right: cond.right };
      }
      case "and":
      case "or": {
        const left = this.rewriteMetricCond(cond.left, rollup);
        const right = this.rewriteMetricCond(cond.right, rollup);
        return left === undefined || right === undefined ? undefined : { k: cond.k, left, right };
      }
      case "not": {
        const operand = this.rewriteMetricCond(cond.operand, rollup);
        return operand === undefined ? undefined : { k: "not", operand };
      }
      case "between": {
        const left = this.rewriteMExpr(cond.left, rollup);
        return left === undefined ? undefined : { k: "between", left, lo: cond.lo, hi: cond.hi };
      }
    }
  }

  private rewriteOut(out: OutExpr, rollup: boolean): OutExpr | undefined {
    switch (out.k) {
      case "num":
        return out;
      case "term": {
        const expr = this.rewriteMExpr(out.expr, rollup);
        return expr === undefined ? undefined : { k: "term", baseName: out.baseName, expr, transform: out.transform };
      }
      case "bin": {
        const left = this.rewriteOut(out.left, rollup);
        const right = this.rewriteOut(out.right, rollup);
        return left === undefined || right === undefined ? undefined : { k: "bin", op: out.op, left, right };
      }
    }
  }

  private rewriteMExpr(expr: MExpr, rollup: boolean): MExpr | undefined {
    if (expr.k === "num") return expr;
    const column = this.byMetric.get(signature(expr));
    if (column !== undefined) {
      const reduce = rollup ? rollupReduce(expr, this.span) : ReAgg.Max;
      return reduce === undefined ? undefined : this.reduceAgg(column, reduce);
    }
    if (expr.k !== "bin") return undefined;
    const left = this.rewriteMExpr(expr.left, rollup);
    const right = this.rewriteMExpr(expr.right, rollup);
    return left === undefined || right === undefined ? undefined : { k: "bin", op: expr.op, left, right };
  }

  private rewriteCond(cond: Cond): Cond | undefined {
    switch (cond.k) {
      case "cmp": {
        const left = this.rewriteColExpr(cond.left);
        if (left === undefined) return undefined;
        if (cond.right.k === "param") return { k: "cmp", op: cond.op, left, right: cond.right };
        const right = this.rewriteColExpr(cond.right);
        return right === undefined ? undefined : { k: "cmp", op: cond.op, left, right };
      }
      case "and":
      case "or": {
        const left = this.rewriteCond(cond.left);
        const right = this.rewriteCond(cond.right);
        return left === undefined || right === undefined ? undefined : { k: cond.k, left, right };
      }
      case "not": {
        const operand = this.rewriteCond(cond.operand);
        return operand === undefined ? undefined : { k: "not", operand };
      }
      case "in": {
        const left = this.rewriteColExpr(cond.left);
        return left === undefined ? undefined : { k: "in", left, values: cond.values };
      }
      case "between": {
        const left = this.rewriteColExpr(cond.left);
        return left === undefined ? undefined : { k: "between", left, lo: cond.lo, hi: cond.hi };
      }
      case "like": {
        const left = this.rewriteColExpr(cond.left);
        return left === undefined ? undefined : { k: "like", left, pattern: cond.pattern };
      }
    }
  }

  private rewriteColExpr(expr: ColExpr): ColExpr | undefined {
    switch (expr.k) {
      case "num":
        return expr;
      case "col": {
        const slot = this.byBase.get(sigCol(expr));
        return slot === undefined || slot.grain !== undefined ? undefined : this.column(slot.column);
      }
      case "trunc": {
        const slot = this.byBase.get(sigCol(expr.arg));
        if (slot === undefined) return undefined;
        if (!bucketReachable(slot, expr.grain, expr.frame)) return undefined;
        return slot.grain === expr.grain
          ? this.column(slot.column)
          : { k: "trunc", grain: expr.grain, arg: this.column(slot.column), frame: carriedFrame(slot, expr.frame) };
      }
      case "bin": {
        const left = this.rewriteColExpr(expr.left);
        const right = this.rewriteColExpr(expr.right);
        return left === undefined || right === undefined ? undefined : { k: "bin", op: expr.op, left, right };
      }
    }
  }

  private column(name: string): ColExpr {
    return { k: "col", ref: { model: this.mv.name, column: name } };
  }

  private reduceAgg(column: string, reduce: ReAgg): MExpr {
    return {
      k: "agg",
      model: this.mv.name,
      func: REAGG_FUNC.get(reduce)!,
      arg: this.column(column),
      distinct: false,
      add: NON_ADDITIVE
    };
  }
}

interface RollupBlocker {
  readonly test: (plan: Plan) => boolean;
  readonly why: string;
}

const ROLLUP_BLOCKERS: readonly RollupBlocker[] = [
  {
    test: (plan) => plan.windowed,
    why: "a transform compares rows against each other, and a comparison cannot be aggregated back up"
  },
  {
    test: (plan) => plan.having !== undefined,
    why: "'having' has already dropped the groups that failed it, and a coarser query cannot bring them back"
  },
  {
    test: (plan) => plan.limit !== undefined,
    why: "'top' has already dropped every group but a few, and a coarser query cannot bring them back"
  }
];

function checkRollup(mv: MaterializationInfo, plan: Plan): void {
  const blocker = ROLLUP_BLOCKERS.find((candidate) => candidate.test(plan));
  if (blocker === undefined) return;
  throw new SemError(
    DiagCode.InvalidDefinition,
    `rollup '${mv.name}' answers queries by aggregating its own rows again, but ${blocker.why}; declare it with 'materialize' if you only want the table built`,
    mv.span
  );
}

function conjuncts(cond: Cond | undefined, into: Cond[] = []): Cond[] {
  if (cond === undefined) return into;
  if (cond.k === "and") {
    conjuncts(cond.left, into);
    conjuncts(cond.right, into);
    return into;
  }
  into.push(cond);
  return into;
}

function carriedFrame(slot: DimSlot, frame: TimeFrame | undefined): TimeFrame | undefined {
  if (slot.grain === undefined) return frame;
  return frame?.fiscalStart === undefined ? undefined : { fiscalStart: frame.fiscalStart };
}

function bucketReachable(slot: DimSlot, grain: TimeGrain | undefined, frame: TimeFrame | undefined): boolean {
  if (grain === undefined) return slot.grain === undefined;
  if (slot.grain === undefined) return true;
  return frameEquals(slot.frame, frame) && GRAIN_ROLLUP.get(slot.grain)!.has(grain);
}

function rollupReduce(expr: MExpr, span: Span): ReAgg | undefined {
  const add = typeOf(expr, span).add;
  if (add.kind !== "additive") return undefined;
  return REAGG_FUNC.has(add.reduce) ? add.reduce : undefined;
}

const PLAN_CACHE = new WeakMap<Catalog, Map<string, Plan>>();

function sourcePlans(catalog: Catalog): Map<string, Plan> {
  const cached = PLAN_CACHE.get(catalog);
  if (cached !== undefined) return cached;
  const plans = new Map<string, Plan>();
  for (const mv of catalog.rollups.values()) {
    const plan = analyze(catalog, mv.query);
    checkRollup(mv, plan);
    plans.set(mv.name, plan);
  }
  PLAN_CACHE.set(catalog, plans);
  return plans;
}

export function checkRollups(catalog: Catalog): void {
  sourcePlans(catalog);
}

export function route(catalog: Catalog, query: Plan, span: Span): RoutedPlan | undefined {
  if (catalog.rollups.size === 0) return undefined;
  const plans = sourcePlans(catalog);
  let best: RoutedPlan | undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const mv of catalog.rollups.values()) {
    const source = plans.get(mv.name)!;
    const routed = new Candidate(mv, source, span).route(query);
    if (routed !== undefined && source.dims.length < bestWidth) {
      best = routed;
      bestWidth = source.dims.length;
    }
  }
  return best;
}
