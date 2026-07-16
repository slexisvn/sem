import {
  AggOverride,
  AsOfClause,
  FunnelDecl,
  FunnelStep,
  RetentionDecl,
  AssertDecl,
  AssertExpectation,
  BetweenExpr,
  BinaryExpr,
  BinaryOp,
  CallExpr,
  DimensionDecl,
  Expr,
  IdentExpr,
  InExpr,
  JoinDecl,
  LiteralExpr,
  MaterializeDecl,
  MeasureDecl,
  MemberExpr,
  MetricDecl,
  MetricSelect,
  ModelDecl,
  NodeKind,
  OrderByClause,
  PolicyDecl,
  Program,
  QueryDecl,
  RefExpr,
  SegmentDecl,
  SortDir,
  TransformArg,
  TransformCall,
  UnaryExpr
} from "../ast/nodes.js";
import { TRANSFORM_NAMES } from "../config/constants.js";
import { DISTINCT_KEYWORD } from "../config/aggregates.js";
import { SEMI_RULE_ORDER, SemiRule } from "../config/additivity.js";
import { baseUnit, divUnit, mulUnit, Unit } from "../config/units.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Span, Token, TokKind } from "../lexer/token.js";
import { tokenize } from "../lexer/lexer.js";

interface InfixOp {
  readonly op: BinaryOp;
  readonly lbp: number;
  readonly rbp: number;
}

const CMP_BP = 5;

const INFIX: ReadonlyMap<TokKind, InfixOp> = new Map([
  [TokKind.Or, { op: "or", lbp: 1, rbp: 2 }],
  [TokKind.And, { op: "and", lbp: 3, rbp: 4 }],
  [TokKind.Eq, { op: "=", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Neq, { op: "!=", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Lt, { op: "<", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Lte, { op: "<=", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Gt, { op: ">", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Gte, { op: ">=", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Like, { op: "like", lbp: CMP_BP, rbp: CMP_BP + 1 }],
  [TokKind.Plus, { op: "+", lbp: 7, rbp: 8 }],
  [TokKind.Minus, { op: "-", lbp: 7, rbp: 8 }],
  [TokKind.Star, { op: "*", lbp: 9, rbp: 10 }],
  [TokKind.Slash, { op: "/", lbp: 9, rbp: 10 }]
]);

const CMP_TOKENS: ReadonlySet<TokKind> = new Set([
  TokKind.Eq,
  TokKind.Neq,
  TokKind.Lt,
  TokKind.Lte,
  TokKind.Gt,
  TokKind.Gte
]);

export class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private stopAtBetween = false;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public static forModels(source: string): Parser {
    return new Parser(tokenize(source));
  }

  private peek(ahead = 0): Token {
    const token = this.tokens[this.index + ahead];
    return token ?? this.tokens[this.tokens.length - 1]!;
  }

  private at(kind: TokKind): boolean {
    return this.peek().kind === kind;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== TokKind.Eof) this.index += 1;
    return token;
  }

  private expect(kind: TokKind, what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new SemError(
        DiagCode.ParseError,
        `expected ${what} but found '${token.text || token.kind}'`,
        token.span
      );
    }
    return this.next();
  }

  private spanFrom(start: Span): Span {
    const prev = this.tokens[this.index - 1] ?? this.peek();
    return { start: start.start, end: prev.span.end };
  }

  public parseModels(): ModelDecl[] {
    return this.parseProgram().models;
  }

  public parseProgram(): Program {
    const models: ModelDecl[] = [];
    const policies: PolicyDecl[] = [];
    const asserts: AssertDecl[] = [];
    const materializes: MaterializeDecl[] = [];
    while (!this.at(TokKind.Eof)) {
      switch (this.peek().kind) {
        case TokKind.Model:
          models.push(this.parseModel());
          break;
        case TokKind.Policy:
          policies.push(this.parsePolicy());
          break;
        case TokKind.Assert:
          asserts.push(this.parseAssert());
          break;
        case TokKind.Materialize:
          materializes.push(this.parseMaterialize());
          break;
        default: {
          const token = this.peek();
          throw new SemError(
            DiagCode.ParseError,
            `expected 'model', 'policy', 'assert', or 'materialize' but found '${token.text || token.kind}'`,
            token.span
          );
        }
      }
    }
    return { models, policies, asserts, materializes };
  }

  public parseQuery(): QueryDecl {
    const start = this.peek().span;
    this.expect(TokKind.Show, "'show'");
    return this.parseQueryAfterShow(start, true);
  }

  public parseFunnel(): FunnelDecl {
    const start = this.peek().span;
    this.expect(TokKind.Funnel, "'funnel'");
    const modelTok = this.expect(TokKind.Ident, "an event model");
    this.expect(TokKind.By, "'by' before the entity key");
    const entity = this.parseRef();
    this.expect(TokKind.Over, "'over' before the time column");
    const time = this.parseRef();
    this.expect(TokKind.Steps, "'steps'");
    const steps: FunnelStep[] = [this.parseFunnelStep()];
    while (this.at(TokKind.Comma)) {
      this.next();
      steps.push(this.parseFunnelStep());
    }
    this.expect(TokKind.Eof, "end of funnel");
    return {
      kind: NodeKind.Funnel,
      model: modelTok.text,
      modelSpan: modelTok.span,
      entity,
      time,
      steps,
      span: this.spanFrom(start)
    };
  }

  private parseFunnelStep(): FunnelStep {
    const nameTok = this.expect(TokKind.Ident, "a step name");
    this.expect(TokKind.Eq, "'=' after the step name");
    const cond = this.parseExpr(0);
    return { name: nameTok.text, nameSpan: nameTok.span, cond };
  }

  public parseRetention(): RetentionDecl {
    const start = this.peek().span;
    this.expect(TokKind.Retention, "'retention'");
    const modelTok = this.expect(TokKind.Ident, "an event model");
    this.expect(TokKind.By, "'by' before the entity key");
    const entity = this.parseRef();
    this.expect(TokKind.Over, "'over' before the time grain");
    const time = this.parseRef();
    this.expect(TokKind.Periods, "'periods'");
    const periodsTok = this.expect(TokKind.Number, "a number of periods");
    this.expect(TokKind.Eof, "end of retention");
    return {
      kind: NodeKind.Retention,
      model: modelTok.text,
      modelSpan: modelTok.span,
      entity,
      time,
      periods: periodsTok.value as number,
      periodsSpan: periodsTok.span,
      span: this.spanFrom(start)
    };
  }

  private parseQueryAfterShow(start: Span, expectEof: boolean): QueryDecl {
    const metrics = this.parseMetricSelectList();

    const dimensions: RefExpr[] = [];
    if (this.at(TokKind.By)) {
      this.next();
      dimensions.push(...this.parseRefList());
    }

    let where: Expr | undefined;
    if (this.at(TokKind.Where)) {
      this.next();
      where = this.parseExpr(0);
    }

    let having: Expr | undefined;
    if (this.at(TokKind.Having)) {
      this.next();
      having = this.parseExpr(0);
    }

    let orderBy: OrderByClause | undefined;
    if (this.at(TokKind.Order)) {
      this.next();
      this.expect(TokKind.By, "'by'");
      const metric = this.parseMetricSelect();
      let dir: SortDir = "asc";
      if (this.at(TokKind.Desc)) {
        this.next();
        dir = "desc";
      } else if (this.at(TokKind.Asc)) {
        this.next();
        dir = "asc";
      }
      orderBy = { metric, dir };
    }

    let top: number | undefined;
    if (this.at(TokKind.Top)) {
      this.next();
      const token = this.expect(TokKind.Number, "a number after 'top'");
      top = token.value as number;
    }

    if (expectEof) this.expect(TokKind.Eof, "end of query");
    return {
      kind: NodeKind.Query,
      metrics,
      dimensions,
      where,
      having,
      orderBy,
      top,
      span: this.spanFrom(start)
    };
  }

  private parseModel(): ModelDecl {
    const start = this.peek().span;
    this.expect(TokKind.Model, "'model'");
    const nameTok = this.expect(TokKind.Ident, "a model name");
    this.expect(TokKind.LBrace, "'{'");

    let table: string | undefined;
    let primaryKey: string | undefined;
    let timezone: string | undefined;
    let timezoneSpan: Span | undefined;
    const joins: JoinDecl[] = [];
    const dimensions: DimensionDecl[] = [];
    const measures: MeasureDecl[] = [];
    const metrics: MetricDecl[] = [];
    const segments: SegmentDecl[] = [];

    while (!this.at(TokKind.RBrace) && !this.at(TokKind.Eof)) {
      switch (this.peek().kind) {
        case TokKind.Table:
          this.next();
          table = this.parseQualifiedName();
          break;
        case TokKind.PrimaryKey:
          this.next();
          primaryKey = this.expect(TokKind.Ident, "a primary key column").text;
          break;
        case TokKind.Timezone: {
          this.next();
          const zone = this.expect(TokKind.String, "a timezone name such as 'Asia/Ho_Chi_Minh'");
          timezone = zone.value as string;
          timezoneSpan = zone.span;
          break;
        }
        case TokKind.Join:
          joins.push(this.parseJoin());
          break;
        case TokKind.Dimension:
          dimensions.push(this.parseDimension());
          break;
        case TokKind.Measure:
          measures.push(this.parseMeasure());
          break;
        case TokKind.Metric:
          metrics.push(this.parseMetric());
          break;
        case TokKind.Segment:
          segments.push(this.parseSegment());
          break;
        default: {
          const token = this.peek();
          throw new SemError(
            DiagCode.ParseError,
            `unexpected '${token.text || token.kind}' inside model '${nameTok.text}'`,
            token.span
          );
        }
      }
    }

    this.expect(TokKind.RBrace, "'}'");

    if (table === undefined) {
      throw new SemError(DiagCode.ParseError, `model '${nameTok.text}' is missing a table`, nameTok.span);
    }
    if (primaryKey === undefined) {
      throw new SemError(
        DiagCode.ParseError,
        `model '${nameTok.text}' is missing a primary_key`,
        nameTok.span
      );
    }

    return {
      kind: NodeKind.Model,
      name: nameTok.text,
      nameSpan: nameTok.span,
      table,
      primaryKey,
      timezone,
      timezoneSpan,
      joins,
      dimensions,
      measures,
      metrics,
      segments,
      span: this.spanFrom(start)
    };
  }

  private parseSegment(): SegmentDecl {
    const start = this.peek().span;
    this.expect(TokKind.Segment, "'segment'");
    const nameTok = this.expect(TokKind.Ident, "a segment name");
    this.expect(TokKind.Eq, "'='");
    const expr = this.parseExpr(0);
    return {
      kind: NodeKind.Segment,
      name: nameTok.text,
      nameSpan: nameTok.span,
      expr,
      span: this.spanFrom(start)
    };
  }

  private parseQualifiedName(): string {
    let name = this.expect(TokKind.Ident, "a table name").text;
    while (this.at(TokKind.Dot)) {
      this.next();
      name += "." + this.expect(TokKind.Ident, "a name segment").text;
    }
    return name;
  }

  private parseJoin(): JoinDecl {
    const start = this.peek().span;
    this.expect(TokKind.Join, "'join'");
    const targetTok = this.expect(TokKind.Ident, "a join target model");
    this.expect(TokKind.On, "'on'");
    const left = this.parseRef();
    const op = this.parseComparisonOp();
    const right = this.parseRef();
    const asof = this.at(TokKind.Asof) ? this.parseAsOf() : undefined;
    this.expect(TokKind.LParen, "'(' before cardinality");
    const cardinality = this.expect(TokKind.Ident, "a cardinality").text;
    this.expect(TokKind.RParen, "')' after cardinality");
    return {
      kind: NodeKind.Join,
      target: targetTok.text,
      targetSpan: targetTok.span,
      left,
      op,
      right,
      asof,
      cardinality,
      span: this.spanFrom(start)
    };
  }

  private parseAsOf(): AsOfClause {
    const start = this.peek().span;
    this.expect(TokKind.Asof, "'asof'");
    const left = this.parseRef();
    const op = this.parseComparisonOp();
    const right = this.parseRef();
    return { left, op, right, span: this.spanFrom(start) };
  }

  private parseComparisonOp(): BinaryOp {
    const token = this.peek();
    if (!CMP_TOKENS.has(token.kind)) {
      throw new SemError(DiagCode.ParseError, `expected a comparison operator but found '${token.text}'`, token.span);
    }
    const info = INFIX.get(token.kind)!;
    this.next();
    return info.op;
  }

  private parseDimension(): DimensionDecl {
    const start = this.peek().span;
    this.expect(TokKind.Dimension, "'dimension'");
    const nameTok = this.expect(TokKind.Ident, "a dimension name");
    this.expect(TokKind.Colon, "':'");
    const typeTok = this.expect(TokKind.Ident, "a dimension type");
    const expr = this.at(TokKind.Eq) ? this.parseDimensionExpr() : this.identColumn(nameTok);
    return {
      kind: NodeKind.Dimension,
      name: nameTok.text,
      nameSpan: nameTok.span,
      dimType: typeTok.text,
      dimTypeSpan: typeTok.span,
      expr,
      span: this.spanFrom(start)
    };
  }

  private parseDimensionExpr(): Expr {
    this.expect(TokKind.Eq, "'='");
    return this.parseExpr(0);
  }

  private identColumn(nameTok: Token): IdentExpr {
    return { kind: NodeKind.Ident, name: nameTok.text, span: nameTok.span };
  }

  private parseMeasure(): MeasureDecl {
    const start = this.peek().span;
    this.expect(TokKind.Measure, "'measure'");
    const nameTok = this.expect(TokKind.Ident, "a measure name");
    let unit: Unit | undefined;
    if (this.at(TokKind.Colon)) {
      this.next();
      unit = this.parseUnit();
    }
    const additivity = this.at(TokKind.Eq) ? undefined : this.parseAggOverride();
    this.expect(TokKind.Eq, "'='");
    const expr = this.parseExpr(0);
    return {
      kind: NodeKind.Measure,
      name: nameTok.text,
      nameSpan: nameTok.span,
      expr,
      unit,
      additivity,
      span: this.spanFrom(start)
    };
  }

  private parseUnit(): Unit {
    let unit = this.parseUnitFactor();
    for (;;) {
      if (this.at(TokKind.Star)) {
        this.next();
        unit = mulUnit(unit, this.parseUnitFactor());
      } else if (this.at(TokKind.Slash)) {
        this.next();
        unit = divUnit(unit, this.parseUnitFactor());
      } else {
        return unit;
      }
    }
  }

  private parseUnitFactor(): Unit {
    return baseUnit(this.expect(TokKind.Ident, "a unit name").text);
  }

  private parseAggOverride(): AggOverride {
    const nameTok = this.expect(TokKind.Ident, "'non_additive' or 'semi_additive'");
    if (nameTok.text === "non_additive") {
      return { kind: "non_additive", span: nameTok.span };
    }
    if (nameTok.text === "semi_additive") {
      this.expect(TokKind.LParen, "'(' after 'semi_additive'");
      const ruleTok = this.expect(TokKind.Ident, "a rule such as 'last' or 'first'");
      const rule = ruleTok.text as SemiRule;
      if (!SEMI_RULE_ORDER.has(rule)) {
        const expected = [...SEMI_RULE_ORDER.keys()].map((r) => `'${r}'`).join(" or ");
        throw new SemError(DiagCode.ParseError, `unknown semi-additive rule '${ruleTok.text}'; expected ${expected}`, ruleTok.span);
      }
      this.expect(TokKind.By, "'by' inside 'semi_additive'");
      const dimTok = this.expect(TokKind.Ident, "a dimension name");
      const close = this.expect(TokKind.RParen, "')' to close 'semi_additive'");
      return { kind: "semi", rule, dim: dimTok.text, dimSpan: dimTok.span, span: { start: nameTok.span.start, end: close.span.end } };
    }
    throw new SemError(
      DiagCode.ParseError,
      `unknown additivity '${nameTok.text}'; expected 'non_additive' or 'semi_additive'`,
      nameTok.span
    );
  }

  private parseMetric(): MetricDecl {
    const start = this.peek().span;
    this.expect(TokKind.Metric, "'metric'");
    const nameTok = this.expect(TokKind.Ident, "a metric name");
    this.expect(TokKind.Eq, "'='");
    const expr = this.parseExpr(0);
    let filter: Expr | undefined;
    if (this.at(TokKind.Where)) {
      this.next();
      filter = this.parseExpr(0);
    }
    return {
      kind: NodeKind.Metric,
      name: nameTok.text,
      nameSpan: nameTok.span,
      expr,
      filter,
      span: this.spanFrom(start)
    };
  }

  private parseRefList(): RefExpr[] {
    const refs: RefExpr[] = [this.parseRef()];
    while (this.at(TokKind.Comma)) {
      this.next();
      refs.push(this.parseRef());
    }
    return refs;
  }

  private parseRef(): RefExpr {
    const nameTok = this.expect(TokKind.Ident, "a name");
    let ref: RefExpr = { kind: NodeKind.Ident, name: nameTok.text, span: nameTok.span };
    while (this.at(TokKind.Dot)) {
      this.next();
      const seg = this.expect(TokKind.Ident, "a name after '.'");
      ref = {
        kind: NodeKind.Member,
        object: ref,
        name: seg.text,
        nameSpan: seg.span,
        span: { start: ref.span.start, end: seg.span.end }
      };
    }
    return ref;
  }

  private parseMetricSelectList(): MetricSelect[] {
    const items: MetricSelect[] = [this.parseMetricSelect()];
    while (this.at(TokKind.Comma)) {
      this.next();
      items.push(this.parseMetricSelect());
    }
    return items;
  }

  private parseMetricSelect(): MetricSelect {
    const first = this.expect(TokKind.Ident, "a metric name");
    let base: RefExpr = { kind: NodeKind.Ident, name: first.text, span: first.span };
    let transform: TransformCall | undefined;

    while (this.at(TokKind.Dot)) {
      const seg = this.peek(1);
      const hasArgs = this.peek(2).kind === TokKind.LParen;
      if (seg.kind === TokKind.Ident && (hasArgs || TRANSFORM_NAMES.has(seg.text))) {
        this.next();
        this.next();
        const args = this.at(TokKind.LParen) ? this.parseTransformArgs() : [];
        transform = { name: seg.text, nameSpan: seg.span, args, span: { start: base.span.start, end: this.prevEnd() } };
        break;
      }
      this.next();
      const memberSeg = this.expect(TokKind.Ident, "a name after '.'");
      base = {
        kind: NodeKind.Member,
        object: base,
        name: memberSeg.text,
        nameSpan: memberSeg.span,
        span: { start: base.span.start, end: memberSeg.span.end }
      };
    }

    return { kind: NodeKind.MetricSelect, base, transform, span: { start: base.span.start, end: this.prevEnd() } };
  }

  private parseTransformArgs(): TransformArg[] {
    this.expect(TokKind.LParen, "'('");
    const args: TransformArg[] = [];
    if (!this.at(TokKind.RParen)) {
      args.push(this.parseTransformArg());
      while (this.at(TokKind.Comma)) {
        this.next();
        args.push(this.parseTransformArg());
      }
    }
    this.expect(TokKind.RParen, "')'");
    return args;
  }

  private parseTransformArg(): TransformArg {
    if (this.at(TokKind.Duration)) {
      const token = this.next();
      return { kind: "duration", text: token.text, span: token.span };
    }
    const ref = this.parseRef();
    return { kind: "dim", ref, span: ref.span };
  }

  private parsePolicy(): PolicyDecl {
    const start = this.peek().span;
    this.expect(TokKind.Policy, "'policy'");
    const nameTok = this.expect(TokKind.Ident, "a policy name");
    this.expect(TokKind.On, "'on'");
    const modelTok = this.expect(TokKind.Ident, "a model name");
    this.expect(TokKind.Restrict, "'restrict'");
    const restrict = this.parseExpr(0);
    return {
      kind: NodeKind.Policy,
      name: nameTok.text,
      nameSpan: nameTok.span,
      model: modelTok.text,
      modelSpan: modelTok.span,
      restrict,
      span: this.spanFrom(start)
    };
  }

  private parseAssert(): AssertDecl {
    const start = this.peek().span;
    this.expect(TokKind.Assert, "'assert'");
    const metric = this.parseMetricSelect();
    let where: Expr | undefined;
    if (this.at(TokKind.Where)) {
      this.next();
      this.stopAtBetween = true;
      where = this.parseExpr(0);
      this.stopAtBetween = false;
    }
    const expectation = this.parseAssertExpectation();
    return { kind: NodeKind.Assert, metric, where, expectation, span: this.spanFrom(start) };
  }

  private parseAssertExpectation(): AssertExpectation {
    if (this.at(TokKind.EqEq)) {
      this.next();
      return { kind: "eq", value: this.parseSignedNumber() };
    }
    if (this.at(TokKind.Between)) {
      this.next();
      const lo = this.parseSignedNumber();
      this.expect(TokKind.And, "'and' inside 'between'");
      const hi = this.parseSignedNumber();
      return { kind: "between", lo, hi };
    }
    const token = this.peek();
    throw new SemError(DiagCode.ParseError, `expected '==' or 'between' in assert but found '${token.text}'`, token.span);
  }

  private parseMaterialize(): MaterializeDecl {
    const start = this.peek().span;
    this.expect(TokKind.Materialize, "'materialize'");
    const nameTok = this.expect(TokKind.Ident, "a materialized view name");
    this.expect(TokKind.As, "'as'");
    const show = this.expect(TokKind.Show, "'show'");
    const query = this.parseQueryAfterShow(show.span, false);
    return {
      kind: NodeKind.Materialize,
      name: nameTok.text,
      nameSpan: nameTok.span,
      query,
      span: this.spanFrom(start)
    };
  }

  private parseSignedNumber(): number {
    let sign = 1;
    if (this.at(TokKind.Minus)) {
      this.next();
      sign = -1;
    }
    const token = this.expect(TokKind.Number, "a number");
    return sign * (token.value as number);
  }

  private prevEnd(): Span["end"] {
    const prev = this.tokens[this.index - 1] ?? this.peek();
    return prev.span.end;
  }

  private parseExpr(minBp: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();

      if (token.kind === TokKind.Between && this.stopAtBetween) break;
      if (token.kind === TokKind.In || token.kind === TokKind.Between) {
        if (CMP_BP < minBp) break;
        this.next();
        left = token.kind === TokKind.In ? this.finishIn(left) : this.finishBetween(left);
        continue;
      }

      const info = INFIX.get(token.kind);
      if (info === undefined || info.lbp < minBp) break;
      this.next();
      const right = this.parseExpr(info.rbp);
      const binary: BinaryExpr = {
        kind: NodeKind.Binary,
        op: info.op,
        left,
        right,
        span: { start: left.span.start, end: right.span.end }
      };
      left = binary;
    }
    return left;
  }

  private finishIn(value: Expr): InExpr {
    this.expect(TokKind.LParen, "'(' after 'in'");
    const list: Expr[] = [];
    if (!this.at(TokKind.RParen)) {
      list.push(this.parseExpr(0));
      while (this.at(TokKind.Comma)) {
        this.next();
        list.push(this.parseExpr(0));
      }
    }
    const close = this.expect(TokKind.RParen, "')' to close 'in' list");
    return {
      kind: NodeKind.In,
      value,
      list,
      span: { start: value.span.start, end: close.span.end }
    };
  }

  private finishBetween(value: Expr): BetweenExpr {
    const lower = this.parseExpr(CMP_BP + 1);
    this.expect(TokKind.And, "'and' inside 'between'");
    const upper = this.parseExpr(CMP_BP + 1);
    return {
      kind: NodeKind.Between,
      value,
      lower,
      upper,
      span: { start: value.span.start, end: upper.span.end }
    };
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.kind === TokKind.Minus) {
      this.next();
      const operand = this.parseUnary();
      const unary: UnaryExpr = {
        kind: NodeKind.Unary,
        op: "-",
        operand,
        span: { start: token.span.start, end: operand.span.end }
      };
      return unary;
    }
    if (token.kind === TokKind.Not) {
      this.next();
      const operand = this.parseExpr(CMP_BP);
      const unary: UnaryExpr = {
        kind: NodeKind.Unary,
        op: "not",
        operand,
        span: { start: token.span.start, end: operand.span.end }
      };
      return unary;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    let atom: Expr;

    switch (token.kind) {
      case TokKind.Number:
        this.next();
        atom = this.literal(token.value as number, "number", token.span);
        break;
      case TokKind.String:
        this.next();
        atom = this.literal(token.value as string, "string", token.span);
        break;
      case TokKind.True:
      case TokKind.False:
        this.next();
        atom = this.literal(token.value as boolean, "boolean", token.span);
        break;
      case TokKind.LParen: {
        this.next();
        const saved = this.stopAtBetween;
        this.stopAtBetween = false;
        const inner = this.parseExpr(0);
        this.stopAtBetween = saved;
        this.expect(TokKind.RParen, "')'");
        atom = inner;
        break;
      }
      case TokKind.Ident:
        this.next();
        atom = { kind: NodeKind.Ident, name: token.text, span: token.span };
        break;
      default:
        throw new SemError(
          DiagCode.ParseError,
          `unexpected '${token.text || token.kind}' in expression`,
          token.span
        );
    }

    return this.parsePostfix(atom);
  }

  private parsePostfix(atom: Expr): Expr {
    let node = atom;
    for (;;) {
      if (this.at(TokKind.Dot)) {
        this.next();
        const seg = this.expect(TokKind.Ident, "a name after '.'");
        if (node.kind !== NodeKind.Ident && node.kind !== NodeKind.Member) {
          throw new SemError(DiagCode.ParseError, "'.' can only follow a name", seg.span);
        }
        const member: MemberExpr = {
          kind: NodeKind.Member,
          object: node,
          name: seg.text,
          nameSpan: seg.span,
          span: { start: node.span.start, end: seg.span.end }
        };
        node = member;
      } else if (this.at(TokKind.LParen)) {
        if (node.kind !== NodeKind.Ident) {
          throw new SemError(DiagCode.ParseError, "call target must be a function name", node.span);
        }
        node = this.finishCall(node);
      } else {
        break;
      }
    }
    return node;
  }

  private finishCall(callee: IdentExpr): CallExpr {
    this.expect(TokKind.LParen, "'('");
    const distinct = this.consumeDistinct();
    const args: Expr[] = [];
    if (!this.at(TokKind.RParen)) {
      args.push(this.parseExpr(0));
      while (this.at(TokKind.Comma)) {
        this.next();
        args.push(this.parseExpr(0));
      }
    }
    const close = this.expect(TokKind.RParen, "')'");
    return {
      kind: NodeKind.Call,
      callee: callee.name,
      calleeSpan: callee.span,
      args,
      distinct,
      span: { start: callee.span.start, end: close.span.end }
    };
  }

  private consumeDistinct(): boolean {
    const token = this.peek();
    if (token.kind !== TokKind.Ident || token.text !== DISTINCT_KEYWORD) return false;
    const following = this.peek(1).kind;
    if (following === TokKind.RParen || following === TokKind.Comma) return false;
    this.next();
    return true;
  }

  private literal(value: string | number | boolean, literalType: LiteralExpr["literalType"], span: Span): LiteralExpr {
    return { kind: NodeKind.Literal, value, literalType, span };
  }
}

export function parseModels(source: string): ModelDecl[] {
  return Parser.forModels(source).parseModels();
}

export function parseProgram(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}

export function parseQuery(source: string): QueryDecl {
  return new Parser(tokenize(source)).parseQuery();
}

export function parseFunnel(source: string): FunnelDecl {
  return new Parser(tokenize(source)).parseFunnel();
}

export function parseRetention(source: string): RetentionDecl {
  return new Parser(tokenize(source)).parseRetention();
}
