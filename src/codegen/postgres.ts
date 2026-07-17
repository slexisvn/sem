import { calendarGrain, CalendarGrain, TimeGrain } from "../config/constants.js";
import { BaseDialect, lateralAsOf, PeriodSeries, quoteZone } from "./dialect.js";

const MONTHS = (later: string, earlier: string): string =>
  `(EXTRACT(YEAR FROM ${later}) - EXTRACT(YEAR FROM ${earlier})) * 12 + (EXTRACT(MONTH FROM ${later}) - EXTRACT(MONTH FROM ${earlier}))`;

const SECONDS = (later: string, earlier: string, per: number): string =>
  `FLOOR(EXTRACT(EPOCH FROM (${later} - ${earlier})) / ${per})`;

const PERIOD_DIFF: ReadonlyMap<TimeGrain, (later: string, earlier: string) => string> = new Map([
  [TimeGrain.Day, (l, e) => SECONDS(l, e, 86400)],
  [TimeGrain.Week, (l, e) => SECONDS(l, e, 604800)],
  [TimeGrain.Month, MONTHS],
  [TimeGrain.Quarter, (l, e) => `(${MONTHS(l, e)}) / 3`],
  [TimeGrain.Year, (l, e) => `EXTRACT(YEAR FROM ${l}) - EXTRACT(YEAR FROM ${e})`]
]);

export class PostgresDialect extends BaseDialect {
  public readonly name = "postgres";

  protected quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  public paramPlaceholder(index1: number): string {
    return `$${index1}`;
  }

  protected localize(expr: string, tz: string): string {
    return `(${expr} AT TIME ZONE ${quoteZone(tz)})`;
  }

  protected truncCalendar(grain: CalendarGrain, expr: string): string {
    return `DATE_TRUNC('${grain}', ${expr})`;
  }

  protected shiftMonths(expr: string, months: number): string {
    const op = months < 0 ? "-" : "+";
    return `(${expr} ${op} INTERVAL '${Math.abs(months)} months')`;
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): PeriodSeries {
    const { count, unit } = this.step(grain);
    const interval = `${count} ${unit}${count > 1 ? "s" : ""}`;
    return { from: `generate_series(${startExpr}, ${endExpr}, INTERVAL '${interval}') AS ${this.ident(columnAlias)}` };
  }

  public orderedQuantile(argSql: string, fraction: number): string {
    return `PERCENTILE_CONT(${fraction}) WITHIN GROUP (ORDER BY ${argSql})`;
  }

  public asOfLateral(table: string, alias: string, keyPred: string, tsPred: string, order: string): string {
    return lateralAsOf(table, alias, keyPred, tsPred, order);
  }

  public periodDiff(grain: TimeGrain, later: string, earlier: string): string {
    return PERIOD_DIFF.get(calendarGrain(grain))!(later, earlier);
  }
}

export const postgres = new PostgresDialect();
