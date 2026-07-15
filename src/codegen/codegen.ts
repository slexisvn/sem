import { Catalog } from "../analyzer/catalog.js";
import {
  ColExpr,
  ColRef,
  Cond,
  DimPlan,
  FactPlan,
  MetricCond,
  MExpr,
  modelSet,
  Plan,
  SelectMetric,
  SqlResult,
  TransformIR,
  ValueRef
} from "../analyzer/ir.js";
import { ArithOp, CmpOp, COMPONENT_PREFIX, CTE_SUFFIX, TransformKind } from "../config/constants.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { SqlDialect } from "./dialect.js";

const CMP_SQL: ReadonlyMap<CmpOp, string> = new Map([
  [CmpOp.Eq, "="],
  [CmpOp.Neq, "<>"],
  [CmpOp.Lt, "<"],
  [CmpOp.Lte, "<="],
  [CmpOp.Gt, ">"],
  [CmpOp.Gte, ">="]
]);

class ParamBag {
  private readonly values: (string | number | boolean)[] = [];

  constructor(private readonly dialect: SqlDialect) {}

  public add(value: string | number | boolean): string {
    this.values.push(value);
    return this.dialect.paramPlaceholder(this.values.length);
  }

  public collect(): (string | number | boolean)[] {
    return this.values;
  }
}

interface Registry {
  readonly order: Array<{ name: string; node: MExpr }>;
  readonly byKey: Map<string, string>;
}

export class Generator {
  private readonly catalog: Catalog;
  private readonly dialect: SqlDialect;

  constructor(catalog: Catalog, dialect: SqlDialect) {
    this.catalog = catalog;
    this.dialect = dialect;
  }

  public generate(plan: Plan): SqlResult {
    if (plan.windowed) return this.genWindowed(plan);
    return plan.strategy === "single" ? this.genSingle(plan) : this.genMulti(plan);
  }

  private genWindowed(plan: Plan): SqlResult {
    const fact = plan.facts[0]!;
    const params = new ParamBag(this.dialect);
    const gridSelect: string[] = [];
    const groupItems: string[] = [];

    for (const dim of plan.dims) {
      const expr = this.renderDim(dim, fact.model, params);
      gridSelect.push(`${expr} AS ${this.dialect.ident(dim.outputName)}`);
      groupItems.push(expr);
    }

    const bases = new Map<string, MExpr>();
    for (const select of plan.selects) if (!bases.has(select.baseName)) bases.set(select.baseName, select.expr);
    for (const [name, expr] of bases) {
      gridSelect.push(`${this.renderMExpr(expr, params)} AS ${this.dialect.ident(name)}`);
    }

    const grid: string[] = [];
    grid.push(`SELECT ${gridSelect.join(", ")}`);
    grid.push(`FROM ${this.tableOf(fact.model)} AS ${this.alias(fact.model)}`);
    grid.push(...this.renderJoins(fact));
    if (fact.filter !== undefined) grid.push(`WHERE ${this.renderCond(fact.filter, params)}`);
    if (groupItems.length > 0) grid.push(`GROUP BY ${groupItems.join(", ")}`);

    const outer: string[] = [];
    for (const dim of plan.dims) outer.push(this.dialect.ident(dim.outputName));
    for (const select of plan.selects) {
      outer.push(`${this.renderWindow(select)} AS ${this.dialect.ident(select.name)}`);
    }

    const lines: string[] = [];
    lines.push(`WITH grid AS (\n  ${grid.join("\n  ")}\n)`);
    lines.push(`SELECT ${outer.join(", ")}`);
    lines.push("FROM grid");
    if (plan.orderBy !== undefined) {
      lines.push(`ORDER BY ${this.dialect.ident(plan.orderBy.name)} ${plan.orderBy.dir.toUpperCase()}`);
    }
    if (plan.limit !== undefined) lines.push(this.dialect.limit(plan.limit));

    return { sql: `${lines.join("\n")};`, params: params.collect() };
  }

  private renderWindow(select: SelectMetric): string {
    const x = `grid.${this.dialect.ident(select.baseName)}`;
    const t = select.transform;
    if (t === undefined) return x;
    return this.renderTransform(x, t);
  }

  private renderTransform(x: string, t: TransformIR): string {
    switch (t.kind) {
      case TransformKind.Mom:
      case TransformKind.Yoy: {
        const order = this.dialect.ident(t.orderDim);
        return `(${x} / NULLIF(LAG(${x}, ${t.lag}) OVER (ORDER BY ${order}), 0) - 1)`;
      }
      case TransformKind.Rolling: {
        const order = this.dialect.ident(t.orderDim);
        return `SUM(${x}) OVER (ORDER BY ${order} ROWS BETWEEN ${t.rows - 1} PRECEDING AND CURRENT ROW)`;
      }
      case TransformKind.Cumulative: {
        const order = this.dialect.ident(t.orderDim);
        return `SUM(${x}) OVER (ORDER BY ${order} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
      }
      case TransformKind.Share: {
        const over = t.partition.length > 0 ? `PARTITION BY ${t.partition.map((d) => this.dialect.ident(d)).join(", ")}` : "";
        return `(${x} / NULLIF(SUM(${x}) OVER (${over}), 0))`;
      }
    }
  }

  private alias(model: string): string {
    return model.toLowerCase();
  }

  private cteName(model: string): string {
    return `${this.alias(model)}${CTE_SUFFIX}`;
  }

  private tableOf(model: string): string {
    return this.catalog.models.get(model)!.table;
  }

  private genSingle(plan: Plan): SqlResult {
    const fact = plan.facts[0]!;
    const params = new ParamBag(this.dialect);
    const selectItems: string[] = [];
    const groupItems: string[] = [];

    for (const dim of plan.dims) {
      const expr = this.renderDim(dim, fact.model, params);
      selectItems.push(`${expr} AS ${this.dialect.ident(dim.outputName)}`);
      groupItems.push(expr);
    }
    for (const select of plan.selects) {
      selectItems.push(`${this.renderMExpr(select.expr, params)} AS ${this.dialect.ident(select.name)}`);
    }

    const lines: string[] = [];
    lines.push(`SELECT ${selectItems.join(", ")}`);
    lines.push(`FROM ${this.tableOf(fact.model)} AS ${this.alias(fact.model)}`);
    lines.push(...this.renderJoins(fact));
    if (fact.filter !== undefined) lines.push(`WHERE ${this.renderCond(fact.filter, params)}`);
    if (groupItems.length > 0) lines.push(`GROUP BY ${groupItems.join(", ")}`);
    if (plan.having !== undefined) lines.push(`HAVING ${this.renderMetricCond(plan.having, params)}`);
    if (plan.orderBy !== undefined) {
      lines.push(`ORDER BY ${this.dialect.ident(plan.orderBy.name)} ${plan.orderBy.dir.toUpperCase()}`);
    }
    if (plan.limit !== undefined) lines.push(this.dialect.limit(plan.limit));

    return { sql: `${lines.join("\n")};`, params: params.collect() };
  }

  private genMulti(plan: Plan): SqlResult {
    const params = new ParamBag(this.dialect);
    const registries = new Map<string, Registry>();
    for (const fact of plan.facts) registries.set(fact.model, { order: [], byKey: new Map() });

    for (const select of plan.selects) this.discover(select.expr, plan, registries);

    const cteLines: string[] = [];
    for (const fact of plan.facts) {
      cteLines.push(this.renderCte(fact, plan, registries.get(fact.model)!, params));
    }

    const finalSelect: string[] = [];
    for (const dim of plan.dims) finalSelect.push(this.dialect.ident(dim.outputName));
    for (const select of plan.selects) {
      finalSelect.push(`${this.finalExpr(select.expr, plan, registries)} AS ${this.dialect.ident(select.name)}`);
    }

    const lines: string[] = [];
    lines.push(`WITH ${cteLines.join(",\n")}`);
    lines.push(`SELECT ${finalSelect.join(", ")}`);
    lines.push(...this.renderFactJoins(plan));
    if (plan.orderBy !== undefined) {
      lines.push(`ORDER BY ${this.dialect.ident(plan.orderBy.name)} ${plan.orderBy.dir.toUpperCase()}`);
    }
    if (plan.limit !== undefined) lines.push(this.dialect.limit(plan.limit));

    return { sql: `${lines.join("\n")};`, params: params.collect() };
  }

  private renderCte(fact: FactPlan, plan: Plan, registry: Registry, params: ParamBag): string {
    const selectItems: string[] = [];
    const groupItems: string[] = [];

    for (const dim of plan.dims) {
      const expr = this.renderDim(dim, fact.model, params);
      selectItems.push(`${expr} AS ${this.dialect.ident(dim.outputName)}`);
      groupItems.push(expr);
    }
    for (const component of registry.order) {
      selectItems.push(`${this.renderMExpr(component.node, params)} AS ${this.dialect.ident(component.name)}`);
    }

    const inner: string[] = [];
    inner.push(`SELECT ${selectItems.join(", ")}`);
    inner.push(`FROM ${this.tableOf(fact.model)} AS ${this.alias(fact.model)}`);
    inner.push(...this.renderJoins(fact));
    if (fact.filter !== undefined) inner.push(`WHERE ${this.renderCond(fact.filter, params)}`);
    if (groupItems.length > 0) inner.push(`GROUP BY ${groupItems.join(", ")}`);

    return `${this.cteName(fact.model)} AS (\n  ${inner.join("\n  ")}\n)`;
  }

  private renderFactJoins(plan: Plan): string[] {
    const dims = plan.dims.map((d) => this.dialect.ident(d.outputName));
    const lines: string[] = [];
    const first = plan.facts[0]!;
    lines.push(`FROM ${this.cteName(first.model)}`);
    for (let i = 1; i < plan.facts.length; i++) {
      const cte = this.cteName(plan.facts[i]!.model);
      if (dims.length > 0) {
        lines.push(`FULL OUTER JOIN ${cte} USING (${dims.join(", ")})`);
      } else {
        lines.push(`CROSS JOIN ${cte}`);
      }
    }
    return lines;
  }

  private discover(node: MExpr, plan: Plan, registries: Map<string, Registry>): void {
    const models = modelSet(node);
    if (models.size <= 1) {
      this.register(this.ownerModel(models, plan), node, registries);
      return;
    }
    if (node.k === "bin") {
      this.discover(node.left, plan, registries);
      this.discover(node.right, plan, registries);
    }
  }

  private register(model: string, node: MExpr, registries: Map<string, Registry>): string {
    const registry = registries.get(model)!;
    const key = signature(node);
    const existing = registry.byKey.get(key);
    if (existing !== undefined) return existing;
    const name = `${COMPONENT_PREFIX}${registry.order.length}`;
    registry.order.push({ name, node });
    registry.byKey.set(key, name);
    return name;
  }

  private finalExpr(node: MExpr, plan: Plan, registries: Map<string, Registry>): string {
    const models = modelSet(node);
    if (models.size <= 1) {
      const model = this.ownerModel(models, plan);
      const name = registries.get(model)!.byKey.get(signature(node))!;
      return `${this.cteName(model)}.${this.dialect.ident(name)}`;
    }
    if (node.k !== "bin") {
      throw new SemError(DiagCode.Unsupported, "cannot combine metrics across fact tables here");
    }
    return this.renderArith(node.op, this.finalExpr(node.left, plan, registries), this.finalExpr(node.right, plan, registries));
  }

  private ownerModel(models: Set<string>, plan: Plan): string {
    for (const model of models) return model;
    return plan.facts[0]!.model;
  }

  private renderJoins(fact: FactPlan): string[] {
    return fact.joins.map((edge) => {
      const op = CMP_SQL.get(edge.op)!;
      return `LEFT JOIN ${this.tableOf(edge.target)} AS ${this.alias(edge.target)} ON ${this.renderColRef(edge.left)} ${op} ${this.renderColRef(edge.right)}`;
    });
  }

  private renderDim(dim: DimPlan, model: string, params: ParamBag): string {
    const base = this.renderColExpr(dim.perFact.get(model)!, params);
    return dim.grain !== undefined ? this.dialect.truncTime(dim.grain, base) : base;
  }

  private renderMExpr(node: MExpr, params: ParamBag): string {
    switch (node.k) {
      case "agg": {
        const arg = this.renderColExpr(node.arg, params);
        const inner = node.filter !== undefined ? `CASE WHEN ${this.renderCond(node.filter, params)} THEN ${arg} END` : arg;
        return `${node.func.toUpperCase()}(${inner})`;
      }
      case "bin":
        return this.renderArith(node.op, this.renderMExpr(node.left, params), this.renderMExpr(node.right, params));
      case "num":
        return String(node.value);
    }
  }

  private renderMetricCond(cond: MetricCond, params: ParamBag): string {
    switch (cond.k) {
      case "cmp":
        return `${this.renderMExpr(cond.left, params)} ${CMP_SQL.get(cond.op)!} ${params.add(cond.right.value)}`;
      case "and":
        return `(${this.renderMetricCond(cond.left, params)} AND ${this.renderMetricCond(cond.right, params)})`;
      case "or":
        return `(${this.renderMetricCond(cond.left, params)} OR ${this.renderMetricCond(cond.right, params)})`;
      case "not":
        return `(NOT ${this.renderMetricCond(cond.operand, params)})`;
      case "between":
        return `${this.renderMExpr(cond.left, params)} BETWEEN ${params.add(cond.lo.value)} AND ${params.add(cond.hi.value)}`;
    }
  }

  private renderCond(cond: Cond, params: ParamBag): string {
    switch (cond.k) {
      case "cmp": {
        const right = isValue(cond.right) ? params.add(cond.right.value) : this.renderColExpr(cond.right, params);
        return `${this.renderColExpr(cond.left, params)} ${CMP_SQL.get(cond.op)!} ${right}`;
      }
      case "and":
        return `(${this.renderCond(cond.left, params)} AND ${this.renderCond(cond.right, params)})`;
      case "or":
        return `(${this.renderCond(cond.left, params)} OR ${this.renderCond(cond.right, params)})`;
      case "not":
        return `(NOT ${this.renderCond(cond.operand, params)})`;
      case "in": {
        const items = cond.values.map((v) => params.add(v.value)).join(", ");
        return `${this.renderColExpr(cond.left, params)} IN (${items})`;
      }
      case "between":
        return `${this.renderColExpr(cond.left, params)} BETWEEN ${params.add(cond.lo.value)} AND ${params.add(cond.hi.value)}`;
      case "like":
        return `${this.renderColExpr(cond.left, params)} LIKE ${params.add(cond.pattern.value)}`;
    }
  }

  private renderColExpr(expr: ColExpr, params: ParamBag): string {
    switch (expr.k) {
      case "col":
        return this.renderColRef(expr.ref);
      case "num":
        return String(expr.value);
      case "trunc":
        return this.dialect.truncTime(expr.grain, this.renderColExpr(expr.arg, params));
      case "bin":
        return this.renderArith(expr.op, this.renderColExpr(expr.left, params), this.renderColExpr(expr.right, params));
    }
  }

  private renderColRef(ref: ColRef): string {
    return `${this.alias(ref.model)}.${this.dialect.ident(ref.column)}`;
  }

  private renderArith(op: ArithOp, left: string, right: string): string {
    if (op === ArithOp.Div) return `(${left} / NULLIF(${right}, 0))`;
    return `(${left} ${op} ${right})`;
  }
}

function isValue(node: ColExpr | ValueRef): node is ValueRef {
  return node.k === "param";
}

function signature(node: MExpr): string {
  switch (node.k) {
    case "agg":
      return `${node.func}(${sigCol(node.arg)}${node.filter !== undefined ? "|" + sigCond(node.filter) : ""})@${node.model}`;
    case "bin":
      return `(${signature(node.left)}${node.op}${signature(node.right)})`;
    case "num":
      return `#${node.value}`;
  }
}

function sigCol(expr: ColExpr): string {
  switch (expr.k) {
    case "col":
      return `${expr.ref.model}.${expr.ref.column}`;
    case "num":
      return `#${expr.value}`;
    case "trunc":
      return `${expr.grain}(${sigCol(expr.arg)})`;
    case "bin":
      return `(${sigCol(expr.left)}${expr.op}${sigCol(expr.right)})`;
  }
}

function sigCond(cond: Cond): string {
  switch (cond.k) {
    case "cmp":
      return `${sigCol(cond.left)}${cond.op}${isValue(cond.right) ? "$" + String(cond.right.value) : sigCol(cond.right)}`;
    case "and":
      return `and(${sigCond(cond.left)},${sigCond(cond.right)})`;
    case "or":
      return `or(${sigCond(cond.left)},${sigCond(cond.right)})`;
    case "not":
      return `not(${sigCond(cond.operand)})`;
    case "in":
      return `in(${sigCol(cond.left)},${cond.values.map((v) => String(v.value)).join(",")})`;
    case "between":
      return `bt(${sigCol(cond.left)},${String(cond.lo.value)},${String(cond.hi.value)})`;
    case "like":
      return `like(${sigCol(cond.left)},${String(cond.pattern.value)})`;
  }
}

export function generate(catalog: Catalog, plan: Plan, dialect: SqlDialect): SqlResult {
  return new Generator(catalog, dialect).generate(plan);
}
