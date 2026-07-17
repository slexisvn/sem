import { calendarGrain, CalendarGrain, TimeFrame, TimeGrain } from "../config/constants.js";
import { BaseDialect, PeriodSeries, quoteZone } from "./dialect.js";

export class BigQueryDialect extends BaseDialect {
  public readonly name = "bigquery";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  protected localize(expr: string, tz: string): string {
    return `DATETIME(${expr}, ${quoteZone(tz)})`;
  }

  protected truncCalendar(grain: CalendarGrain, expr: string, frame: TimeFrame | undefined): string {
    return `${this.family(frame)}_TRUNC(${expr}, ${grain.toUpperCase()})`;
  }

  protected shiftMonths(expr: string, months: number, frame: TimeFrame | undefined): string {
    const verb = months < 0 ? "SUB" : "ADD";
    return `${this.family(frame)}_${verb}(${expr}, INTERVAL ${Math.abs(months)} MONTH)`;
  }

  private family(frame: TimeFrame | undefined): string {
    return frame?.tz === undefined ? "DATE" : "DATETIME";
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): PeriodSeries {
    const { count, unit } = this.step(grain);
    const interval = `INTERVAL ${count} ${unit.toUpperCase()}`;
    return { from: `UNNEST(GENERATE_DATE_ARRAY(${startExpr}, ${endExpr}, ${interval})) AS ${this.ident(columnAlias)}` };
  }

  public asOfLateral(table: string, alias: string, keyPred: string, tsPred: string, order: string): string {
    const inner = `SELECT AS STRUCT ${alias}.* FROM ${table} AS ${alias} WHERE ${keyPred} AND ${tsPred} ORDER BY ${order} LIMIT 1`;
    return `LEFT JOIN UNNEST(ARRAY(${inner})) AS ${alias}`;
  }

  public periodDiff(grain: TimeGrain, later: string, earlier: string): string {
    return `DATE_DIFF(DATE(${later}), DATE(${earlier}), ${calendarGrain(grain).toUpperCase()})`;
  }

  public approxQuantile(argSql: string, fraction: number): string {
    return `APPROX_QUANTILES(${argSql}, 100)[OFFSET(${Math.round(fraction * 100)})]`;
  }
}

export const bigquery = new BigQueryDialect();
