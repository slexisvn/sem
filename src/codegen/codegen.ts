import { Catalog } from "../analyzer/catalog.js";
import {
  AsOfInfo,
  ColExpr,
  ColRef,
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
  SqlResult,
  TransformIR,
  ValueRef
} from "../analyzer/ir.js";
import {
  AggFunc,
  ArithOp,
  ASOF_ORDER,
  CmpOp,
  COMPONENT_PREFIX,
  CTE_SUFFIX,
  DEDUP_KEY_ALIAS,
  DEDUP_VALUE_PREFIX,
  DENSE_CTE,
  FUNNEL_CTE,
  FUNNEL_ENTITY_ALIAS,
  FUNNEL_STEP_PREFIX,
  RETENTION_ACTIVITY_CTE,
  RETENTION_COHORT,
  RETENTION_COHORT_COL,
  RETENTION_COHORT_CTE,
  RETENTION_ENTITY,
  RETENTION_EVENTS_CTE,
  RETENTION_OFFSET,
  RETENTION_PERIOD,
  RETENTION_PERIOD_PREFIX,
  GRID_CTE,
  SEMI_ORDER_PREFIX,
  SEMI_WINDOW_PREFIX,
  SERIESLESS_TRANSFORMS,
  SPINE_CTE,
  SPINE_PERIOD_COL,
  TransformKind
} from "../config/constants.js";
import { aggIsApprox, aggQuantile, REAGG_SQL } from "../config/aggregates.js";
import { SemiRule } from "../config/additivity.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { SqlDialect } from "./dialect.js";

const RUNNING_FRAME = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";

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

interface Column {
  readonly name: string;
  readonly node: MExpr;
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

  public generateFunnel(plan: FunnelPlan): SqlResult {
    const params = new ParamBag(this.dialect);
    const entitySql = this.renderColRef(plan.entity);
    const timeSql = this.renderColRef(plan.time);
    const stepCols = plan.steps.map((step, i) => {
      const col = `${FUNNEL_STEP_PREFIX}${i}`;
      return `MIN(CASE WHEN ${this.renderCond(step.cond, params)} THEN ${timeSql} END) AS ${col}`;
    });
    const base = [
      `SELECT ${entitySql} AS ${FUNNEL_ENTITY_ALIAS}, ${stepCols.join(", ")}`,
      `FROM ${this.tableRef(plan.model)}`,
      `GROUP BY ${entitySql}`
    ].join("\n  ");

    const guards: string[] = [];
    const counts = plan.steps.map((step, i) => {
      const col = `${FUNNEL_CTE}.${FUNNEL_STEP_PREFIX}${i}`;
      guards.push(i === 0 ? `${col} IS NOT NULL` : `${col} >= ${FUNNEL_CTE}.${FUNNEL_STEP_PREFIX}${i - 1}`);
      return `SUM(CASE WHEN ${guards.join(" AND ")} THEN 1 ELSE 0 END) AS ${this.dialect.ident(step.name)}`;
    });

    const sql = `WITH ${FUNNEL_CTE} AS (\n  ${base}\n)\nSELECT ${counts.join(", ")}\nFROM ${FUNNEL_CTE};`;
    return { sql, params: params.collect() };
  }

  public generateRetention(plan: RetentionPlan): SqlResult {
    if (this.dialect.periodDiff === undefined) {
      throw new SemError(DiagCode.Unsupported, `dialect '${this.dialect.name}' does not support retention`);
    }
    const period = this.dialect.truncTime(plan.grain, this.renderColRef(plan.time));
    const events = [
      `SELECT ${this.renderColRef(plan.entity)} AS ${RETENTION_ENTITY}, ${period} AS ${RETENTION_PERIOD}`,
      `FROM ${this.tableRef(plan.model)}`
    ].join("\n  ");
    const cohorts = `SELECT ${RETENTION_ENTITY}, MIN(${RETENTION_PERIOD}) AS ${RETENTION_COHORT} FROM ${RETENTION_EVENTS_CTE} GROUP BY ${RETENTION_ENTITY}`;
    const offset = this.dialect.periodDiff(plan.grain, `e.${RETENTION_PERIOD}`, `c.${RETENTION_COHORT}`);
    const activity = [
      `SELECT DISTINCT c.${RETENTION_COHORT} AS ${RETENTION_COHORT_COL}, e.${RETENTION_ENTITY} AS ${RETENTION_ENTITY}, ${offset} AS ${RETENTION_OFFSET}`,
      `FROM ${RETENTION_EVENTS_CTE} AS e JOIN ${RETENTION_COHORT_CTE} AS c ON e.${RETENTION_ENTITY} = c.${RETENTION_ENTITY}`
    ].join("\n  ");

    const columns = [RETENTION_COHORT_COL];
    for (let k = 0; k <= plan.periods; k++) {
      columns.push(`COUNT(DISTINCT CASE WHEN ${RETENTION_OFFSET} = ${k} THEN ${RETENTION_ENTITY} END) AS ${RETENTION_PERIOD_PREFIX}${k}`);
    }

    const ctes = [
      `${RETENTION_EVENTS_CTE} AS (\n  ${events}\n)`,
      `${RETENTION_COHORT_CTE} AS (\n  ${cohorts}\n)`,
      `${RETENTION_ACTIVITY_CTE} AS (\n  ${activity}\n)`
    ].join(",\n");
    const sql = `WITH ${ctes}\nSELECT ${columns.join(", ")}\nFROM ${RETENTION_ACTIVITY_CTE}\nGROUP BY ${RETENTION_COHORT_COL}\nORDER BY ${RETENTION_COHORT_COL};`;
    return { sql, params: [] };
  }

  private genWindowed(plan: Plan): SqlResult {
    const fact = plan.facts[0]!;
    const params = new ParamBag(this.dialect);
    const bases = new Map<string, MExpr>();
    for (const select of plan.selects) if (!bases.has(select.baseName)) bases.set(select.baseName, select.expr);
    const columns = [...bases].map(([name, expr]) => ({ name, node: expr }));

    const grid = this.aggregationBody(fact, plan.dims, columns, params);
    const ctes = [`${GRID_CTE} AS (\n  ${grid.join("\n  ")}\n)`];

    const timeDim = plan.dims.find((dim) => dim.grain !== undefined);
    const hasSeries = plan.selects.some((s) => s.transform !== undefined && !SERIESLESS_TRANSFORMS.has(s.transform.kind));
    const densify = hasSeries && timeDim !== undefined && this.dialect.periodSeries !== undefined;
    const source = densify ? DENSE_CTE : GRID_CTE;

    if (densify) ctes.push(...this.densifyCtes(plan, timeDim!, [...bases.keys()]));

    const outer: string[] = [];
    for (const dim of plan.dims) outer.push(this.dialect.ident(dim.outputName));
    for (const select of plan.selects) {
      outer.push(`${this.renderWindow(select, source)} AS ${this.dialect.ident(select.name)}`);
    }

    const lines: string[] = [];
    lines.push(`WITH ${ctes.join(",\n")}`);
    lines.push(`SELECT ${outer.join(", ")}`);
    lines.push(`FROM ${source}`);
    if (plan.orderBy !== undefined) {
      lines.push(`ORDER BY ${this.dialect.ident(plan.orderBy.name)} ${plan.orderBy.dir.toUpperCase()}`);
    }
    if (plan.limit !== undefined) lines.push(this.dialect.limit(plan.limit));

    return { sql: `${lines.join("\n")};`, params: params.collect() };
  }

  private densifyCtes(plan: Plan, timeDim: DimPlan, baseNames: string[]): string[] {
    const time = this.dialect.ident(timeDim.outputName);
    const partitionDims = plan.dims.filter((dim) => dim.outputName !== timeDim.outputName);
    const partitionIdents = partitionDims.map((dim) => this.dialect.ident(dim.outputName));

    const minExpr = `(SELECT MIN(${time}) FROM ${GRID_CTE})`;
    const maxExpr = `(SELECT MAX(${time}) FROM ${GRID_CTE})`;
    const series = this.dialect.periodSeries!(timeDim.grain!, minExpr, maxExpr, SPINE_PERIOD_COL);
    const period = this.dialect.ident(SPINE_PERIOD_COL);

    const spineSelect = [`${period} AS ${time}`, ...partitionIdents.map((id) => `combos.${id} AS ${id}`)];
    const spineLines = [`SELECT ${spineSelect.join(", ")}`, `FROM ${series}`];
    if (partitionIdents.length > 0) {
      spineLines.push(`CROSS JOIN (SELECT DISTINCT ${partitionIdents.join(", ")} FROM ${GRID_CTE}) AS combos`);
    }

    const denseSelect = [`${SPINE_CTE}.${time} AS ${time}`];
    for (const id of partitionIdents) denseSelect.push(`${SPINE_CTE}.${id} AS ${id}`);
    for (const base of baseNames) {
      const id = this.dialect.ident(base);
      denseSelect.push(`${GRID_CTE}.${id} AS ${id}`);
    }
    const joinKeys = [time, ...partitionIdents].map((id) => `${SPINE_CTE}.${id} = ${GRID_CTE}.${id}`);
    const denseLines = [
      `SELECT ${denseSelect.join(", ")}`,
      `FROM ${SPINE_CTE}`,
      `LEFT JOIN ${GRID_CTE} ON ${joinKeys.join(" AND ")}`
    ];

    return [`${SPINE_CTE} AS (\n  ${spineLines.join("\n  ")}\n)`, `${DENSE_CTE} AS (\n  ${denseLines.join("\n  ")}\n)`];
  }

  private renderWindow(select: SelectMetric, source: string): string {
    const x = `${source}.${this.dialect.ident(select.baseName)}`;
    const t = select.transform;
    if (t === undefined) return x;
    return this.renderTransform(x, t);
  }

  private renderTransform(x: string, t: TransformIR): string {
    switch (t.kind) {
      case TransformKind.Mom:
      case TransformKind.Yoy: {
        const over = this.windowSpec(t.partition, t.orderDim);
        return `(${x} / NULLIF(LAG(${x}, ${t.lag}) OVER (${over}), 0) - 1)`;
      }
      case TransformKind.Rolling: {
        const over = this.windowSpec(t.partition, t.orderDim, `ROWS BETWEEN ${t.rows - 1} PRECEDING AND CURRENT ROW`);
        return `${REAGG_SQL.get(t.combinator)!}(${x}) OVER (${over})`;
      }
      case TransformKind.Cumulative: {
        const over = this.windowSpec(t.partition, t.orderDim, RUNNING_FRAME);
        return `${REAGG_SQL.get(t.combinator)!}(${x}) OVER (${over})`;
      }
      case TransformKind.Mtd:
      case TransformKind.Qtd:
      case TransformKind.Ytd: {
        const bucket = this.dialect.truncTime(t.periodGrain, this.dialect.ident(t.orderDim));
        const partition = `PARTITION BY ${[...t.partition.map((d) => this.dialect.ident(d)), bucket].join(", ")}`;
        const over = [partition, `ORDER BY ${this.dialect.ident(t.orderDim)}`, RUNNING_FRAME].join(" ");
        return `${REAGG_SQL.get(t.combinator)!}(${x}) OVER (${over})`;
      }
      case TransformKind.Share: {
        return `(${x} / NULLIF(SUM(${x}) OVER (${this.partitionClause(t.partition)}), 0))`;
      }
      case TransformKind.Of: {
        return `${REAGG_SQL.get(t.combinator)!}(${x}) OVER (${this.partitionClause(t.partition)})`;
      }
    }
  }

  private windowSpec(partition: string[], orderDim: string, frame?: string): string {
    const parts = [this.partitionClause(partition), `ORDER BY ${this.dialect.ident(orderDim)}`];
    if (frame !== undefined) parts.push(frame);
    return parts.filter((part) => part.length > 0).join(" ");
  }

  private partitionClause(partition: string[]): string {
    return partition.length > 0 ? `PARTITION BY ${partition.map((d) => this.dialect.ident(d)).join(", ")}` : "";
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

  private tableRef(model: string): string {
    return `${this.dialect.qualifiedName(this.tableOf(model))} AS ${this.alias(model)}`;
  }

  private aggregationBody(fact: FactPlan, dims: DimPlan[], columns: Column[], params: ParamBag): string[] {
    if (columns.some((column) => hasSemiAdditive(column.node))) {
      return this.semiAggregation(fact, dims, columns, params);
    }
    return fact.fannedOut === true
      ? this.dedupedAggregation(fact, dims, columns, params)
      : this.directAggregation(fact, dims, columns, params);
  }

  private semiAggregation(fact: FactPlan, dims: DimPlan[], columns: Column[], params: ParamBag): string[] {
    const alias = this.alias(fact.model);
    const dimExprs = dims.map((dim) => this.renderDim(dim, fact.model, params));
    const partition = dimExprs.length > 0 ? `PARTITION BY ${dimExprs.join(", ")}` : "";
    const bindings = new SemiBindings(this.dialect, partition);

    const outerColumns = columns.map(
      (column) => `${this.renderSemiOuter(column.node, alias, bindings, params)} AS ${this.dialect.ident(column.name)}`
    );

    const dimProjections = dims.map((dim, i) => `${dimExprs[i]} AS ${this.dialect.ident(dim.outputName)}`);
    const inner = [
      `SELECT ${[...dimProjections, ...bindings.projections()].join(", ")}`,
      `FROM ${this.tableRef(fact.model)}`,
      ...this.renderJoins(fact)
    ];
    if (fact.filter !== undefined) inner.push(`WHERE ${this.renderCond(fact.filter, params)}`);

    const outerDims = dims.map((dim) => `${alias}.${this.dialect.ident(dim.outputName)}`);
    const selectItems = dims
      .map((dim, i) => `${outerDims[i]} AS ${this.dialect.ident(dim.outputName)}`)
      .concat(outerColumns);

    const lines = [`SELECT ${selectItems.join(", ")}`, `FROM (`, `  ${inner.join("\n  ")}`, `) AS ${alias}`];
    if (outerDims.length > 0) lines.push(`GROUP BY ${outerDims.join(", ")}`);
    return lines;
  }

  private renderSemiOuter(node: MExpr, alias: string, bindings: SemiBindings, params: ParamBag): string {
    if (node.k === "bin") {
      return this.renderArith(node.op, this.renderSemiOuter(node.left, alias, bindings, params), this.renderSemiOuter(node.right, alias, bindings, params));
    }
    if (node.k === "num") return String(node.value);

    const valueRef = `${alias}.${this.dialect.ident(bindings.value(node, () => this.renderSemiValue(node, params)))}`;
    if (node.add?.kind !== "semi") {
      return this.renderAggregateCall(node, valueRef);
    }
    const orderSql = this.renderColExpr(node.semiCol!, params);
    const orderRef = `${alias}.${this.dialect.ident(bindings.order(node.semiCol!, orderSql))}`;
    const windowRef = `${alias}.${this.dialect.ident(bindings.window(node.semiCol!, node.add.rule, orderSql))}`;
    return `${REAGG_SQL.get(node.add.reduce)!}(CASE WHEN ${orderRef} = ${windowRef} THEN ${valueRef} END)`;
  }

  private renderSemiValue(node: Extract<MExpr, { k: "agg" }>, params: ParamBag): string {
    const argSql = this.renderColExpr(node.arg, params);
    return node.filter !== undefined ? `CASE WHEN ${this.renderCond(node.filter, params)} THEN ${argSql} END` : argSql;
  }

  private directAggregation(fact: FactPlan, dims: DimPlan[], columns: Column[], params: ParamBag): string[] {
    const dimExprs = dims.map((dim) => this.renderDim(dim, fact.model, params));
    const selectItems = dims.map((dim, i) => `${dimExprs[i]} AS ${this.dialect.ident(dim.outputName)}`);
    for (const column of columns) {
      selectItems.push(`${this.renderMExpr(column.node, params)} AS ${this.dialect.ident(column.name)}`);
    }

    const lines = [`SELECT ${selectItems.join(", ")}`, `FROM ${this.tableRef(fact.model)}`, ...this.renderJoins(fact)];
    if (fact.filter !== undefined) lines.push(`WHERE ${this.renderCond(fact.filter, params)}`);
    if (dimExprs.length > 0) lines.push(`GROUP BY ${dimExprs.join(", ")}`);
    return lines;
  }

  private dedupedAggregation(fact: FactPlan, dims: DimPlan[], columns: Column[], params: ParamBag): string[] {
    const alias = this.alias(fact.model);
    const pkColumn = this.catalog.models.get(fact.model)!.primaryKey;
    const values = new Map<string, string>();
    const valueProjections: string[] = [];

    const dimProjections = dims.map(
      (dim) => `${this.renderDim(dim, fact.model, params)} AS ${this.dialect.ident(dim.outputName)}`
    );

    const project = (node: MExpr): MExpr => {
      if (node.k === "bin") return { k: "bin", op: node.op, left: project(node.left), right: project(node.right) };
      if (node.k === "num") return node;
      const key = signature(node);
      let valueAlias = values.get(key);
      if (valueAlias === undefined) {
        valueAlias = `${DEDUP_VALUE_PREFIX}${values.size}`;
        values.set(key, valueAlias);
        const argSql = this.renderColExpr(node.arg, params);
        const valueSql =
          node.filter !== undefined ? `CASE WHEN ${this.renderCond(node.filter, params)} THEN ${argSql} END` : argSql;
        valueProjections.push(`${valueSql} AS ${this.dialect.ident(valueAlias)}`);
      }
      return { k: "agg", model: fact.model, func: node.func, distinct: node.distinct, arg: { k: "col", ref: { model: fact.model, column: valueAlias } } };
    };

    const outerColumns = columns.map(
      (column) => `${this.renderMExpr(project(column.node), params)} AS ${this.dialect.ident(column.name)}`
    );

    const pkProjection = `${alias}.${this.dialect.ident(pkColumn)} AS ${this.dialect.ident(DEDUP_KEY_ALIAS)}`;
    const inner = [
      `SELECT DISTINCT ${[pkProjection, ...dimProjections, ...valueProjections].join(", ")}`,
      `FROM ${this.tableRef(fact.model)}`,
      ...this.renderJoins(fact)
    ];
    if (fact.filter !== undefined) inner.push(`WHERE ${this.renderCond(fact.filter, params)}`);

    const outerDims = dims.map((dim) => `${alias}.${this.dialect.ident(dim.outputName)}`);
    const selectItems = dims.map((dim, i) => `${outerDims[i]} AS ${this.dialect.ident(dim.outputName)}`).concat(outerColumns);

    const lines = [`SELECT ${selectItems.join(", ")}`, `FROM (`, `  ${inner.join("\n  ")}`, `) AS ${alias}`];
    if (outerDims.length > 0) lines.push(`GROUP BY ${outerDims.join(", ")}`);
    return lines;
  }

  private genSingle(plan: Plan): SqlResult {
    const fact = plan.facts[0]!;
    const params = new ParamBag(this.dialect);
    const columns = plan.selects.map((select) => ({ name: select.name, node: select.expr }));

    const lines = this.aggregationBody(fact, plan.dims, columns, params);
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
    const columns = registry.order.map((component) => ({ name: component.name, node: component.node }));
    const inner = this.aggregationBody(fact, plan.dims, columns, params);
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
    return fact.joins.map((edge) => (edge.asof !== undefined ? this.renderAsOfJoin(edge, edge.asof) : this.renderEquiJoin(edge)));
  }

  private renderEquiJoin(edge: JoinEdge): string {
    const op = CMP_SQL.get(edge.op)!;
    return `LEFT JOIN ${this.tableRef(edge.target)} ON ${this.renderColRef(edge.left)} ${op} ${this.renderColRef(edge.right)}`;
  }

  private renderAsOfJoin(edge: JoinEdge, asof: AsOfInfo): string {
    if (this.dialect.asOfLateral === undefined) {
      throw new SemError(DiagCode.Unsupported, `dialect '${this.dialect.name}' does not support asof joins`, edge.span);
    }
    const keyPred = `${this.renderColRef(edge.left)} ${CMP_SQL.get(edge.op)!} ${this.renderColRef(edge.right)}`;
    const tsPred = `${this.renderColRef(asof.left)} ${CMP_SQL.get(asof.op)!} ${this.renderColRef(asof.right)}`;
    const order = `${this.renderColRef(asof.right)} ${ASOF_ORDER.get(asof.op)!.toUpperCase()}`;
    return this.dialect.asOfLateral(this.dialect.qualifiedName(this.tableOf(edge.target)), this.alias(edge.target), keyPred, tsPred, order);
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
        return this.renderAggregateCall(node, inner);
      }
      case "bin":
        return this.renderArith(node.op, this.renderMExpr(node.left, params), this.renderMExpr(node.right, params));
      case "num":
        return String(node.value);
    }
  }

  private renderAggregateCall(node: Extract<MExpr, { k: "agg" }>, valueSql: string): string {
    const quantile = aggQuantile(node.func);
    if (quantile !== undefined) {
      const rendered = this.quantileSql(node.func, valueSql, quantile ?? node.quantile!);
      if (rendered === undefined) {
        throw new SemError(DiagCode.Unsupported, `dialect '${this.dialect.name}' does not support the '${node.func}' aggregate`);
      }
      return rendered;
    }
    const prefix = node.distinct ? "DISTINCT " : "";
    return `${node.func.toUpperCase()}(${prefix}${valueSql})`;
  }

  private quantileSql(func: AggFunc, valueSql: string, fraction: number): string | undefined {
    const exact = this.dialect.orderedQuantile?.(valueSql, fraction);
    return aggIsApprox(func) ? this.dialect.approxQuantile?.(valueSql, fraction) ?? exact : exact;
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
        return `NOT COALESCE((${this.renderMetricCond(cond.operand, params)}), FALSE)`;
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
        return `NOT COALESCE((${this.renderCond(cond.operand, params)}), FALSE)`;
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
      return `${node.func}${node.quantile !== undefined ? ":" + node.quantile : ""}(${node.distinct ? "distinct " : ""}${sigCol(node.arg)}${node.filter !== undefined ? "|" + sigCond(node.filter) : ""})@${node.model}`;
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

const SEMI_WINDOW_FUNC: ReadonlyMap<SemiRule, string> = new Map([
  ["last", "MAX"],
  ["first", "MIN"]
]);

class SemiBindings {
  private readonly values = new Map<string, string>();
  private readonly orders = new Map<string, string>();
  private readonly windows = new Map<string, string>();
  private readonly valueProjections: string[] = [];
  private readonly orderProjections: string[] = [];
  private readonly windowProjections: string[] = [];

  constructor(private readonly dialect: SqlDialect, private readonly partition: string) {}

  public value(node: Extract<MExpr, { k: "agg" }>, render: () => string): string {
    return this.intern(this.values, this.valueProjections, signature(node), DEDUP_VALUE_PREFIX, render);
  }

  public order(col: ColExpr, sql: string): string {
    return this.intern(this.orders, this.orderProjections, sigCol(col), SEMI_ORDER_PREFIX, () => sql);
  }

  public window(col: ColExpr, rule: SemiRule, sql: string): string {
    const key = `${rule}:${sigCol(col)}`;
    return this.intern(this.windows, this.windowProjections, key, SEMI_WINDOW_PREFIX, () => `${SEMI_WINDOW_FUNC.get(rule)!}(${sql}) OVER (${this.partition})`);
  }

  public projections(): string[] {
    return [...this.valueProjections, ...this.orderProjections, ...this.windowProjections];
  }

  private intern(map: Map<string, string>, projections: string[], key: string, prefix: string, render: () => string): string {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const name = `${prefix}${map.size}`;
    map.set(key, name);
    projections.push(`${render()} AS ${this.dialect.ident(name)}`);
    return name;
  }
}

export function generate(catalog: Catalog, plan: Plan, dialect: SqlDialect): SqlResult {
  return new Generator(catalog, dialect).generate(plan);
}

export function generateFunnel(catalog: Catalog, plan: FunnelPlan, dialect: SqlDialect): SqlResult {
  return new Generator(catalog, dialect).generateFunnel(plan);
}

export function generateRetention(catalog: Catalog, plan: RetentionPlan, dialect: SqlDialect): SqlResult {
  return new Generator(catalog, dialect).generateRetention(plan);
}
