import {
  calendarGrain,
  CalendarGrain,
  CALENDAR_GRAIN,
  fiscalOffset,
  GrainStep,
  GRAIN_STEP,
  TimeFrame,
  TimeGrain
} from "../config/constants.js";

export interface PeriodSeries {
  readonly from: string;
  readonly ctes?: readonly string[];
  readonly recursive?: boolean;
}

export interface SqlDialect {
  readonly name: string;
  ident(name: string): string;
  qualifiedName(dotted: string): string;
  paramPlaceholder(index1: number): string;
  truncTime(grain: TimeGrain, expr: string, frame?: TimeFrame): string;
  limit(n: number): string;
  periodSeries?(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): PeriodSeries;
  orderedQuantile?(argSql: string, fraction: number): string;
  approxQuantile?(argSql: string, fraction: number): string;
  asOfLateral?(table: string, alias: string, keyPred: string, tsPred: string, order: string): string;
  periodDiff?(grain: TimeGrain, later: string, earlier: string): string;
}

export function quoteZone(tz: string): string {
  return `'${tz.replace(/'/g, "''")}'`;
}

export function lateralAsOf(table: string, alias: string, keyPred: string, tsPred: string, order: string): string {
  const inner = `SELECT * FROM ${table} AS ${alias} WHERE ${keyPred} AND ${tsPred} ORDER BY ${order} LIMIT 1`;
  return `LEFT JOIN LATERAL (${inner}) AS ${alias} ON TRUE`;
}

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;

export abstract class BaseDialect implements SqlDialect {
  public abstract readonly name: string;

  protected abstract quote(name: string): string;
  public abstract paramPlaceholder(index1: number): string;
  protected abstract localize(expr: string, tz: string): string;
  protected abstract truncCalendar(grain: CalendarGrain, expr: string, frame: TimeFrame | undefined): string;
  protected abstract shiftMonths(expr: string, months: number, frame: TimeFrame | undefined): string;

  public ident(name: string): string {
    return SIMPLE_IDENT.test(name) ? name : this.quote(name);
  }

  public qualifiedName(dotted: string): string {
    return dotted
      .split(".")
      .map((part) => this.ident(part))
      .join(".");
  }

  public limit(n: number): string {
    return `LIMIT ${n}`;
  }

  public truncTime(grain: TimeGrain, expr: string, frame?: TimeFrame): string {
    const local = frame?.tz === undefined ? expr : this.localize(expr, frame.tz);
    const offset = CALENDAR_GRAIN.has(grain) ? fiscalOffset(frame) : 0;
    if (offset === 0) return this.truncCalendar(calendarGrain(grain), local, frame);
    const shifted = this.truncCalendar(calendarGrain(grain), this.shiftMonths(local, -offset, frame), frame);
    return this.shiftMonths(shifted, offset, frame);
  }

  protected step(grain: TimeGrain): GrainStep {
    return GRAIN_STEP.get(grain)!;
  }
}
