import { calendarGrain, CalendarGrain, SPINE_SEQ_CTE, TimeGrain } from "../config/constants.js";
import { BaseDialect, lateralAsOf, PeriodSeries, quoteZone } from "./dialect.js";

const UTC = "'UTC'";

export class MySqlDialect extends BaseDialect {
  public readonly name = "mysql";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  protected localize(expr: string, tz: string): string {
    return `CONVERT_TZ(${expr}, ${UTC}, ${quoteZone(tz)})`;
  }

  protected shiftMonths(expr: string, months: number): string {
    const verb = months < 0 ? "DATE_SUB" : "DATE_ADD";
    return `${verb}(${expr}, INTERVAL ${Math.abs(months)} MONTH)`;
  }

  protected truncCalendar(grain: CalendarGrain, expr: string): string {
    switch (grain) {
      case TimeGrain.Day:
        return `DATE(${expr})`;
      case TimeGrain.Week:
        return `STR_TO_DATE(CONCAT(YEARWEEK(${expr}, 3), ' Monday'), '%X%V %W')`;
      case TimeGrain.Month:
        return `DATE_FORMAT(${expr}, '%Y-%m-01')`;
      case TimeGrain.Quarter:
        return `STR_TO_DATE(CONCAT(YEAR(${expr}), '-', LPAD(((QUARTER(${expr}) - 1) * 3 + 1), 2, '0'), '-01'), '%Y-%m-%d')`;
      case TimeGrain.Year:
        return `DATE_FORMAT(${expr}, '%Y-01-01')`;
    }
  }

  public asOfLateral(table: string, alias: string, keyPred: string, tsPred: string, order: string): string {
    return lateralAsOf(table, alias, keyPred, tsPred, order);
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): PeriodSeries {
    const { count, unit } = this.step(grain);
    const column = this.ident(columnAlias);
    const next = `DATE_ADD(${column}, INTERVAL ${count} ${unit.toUpperCase()})`;
    const seed = `SELECT ${startExpr} AS ${column}`;
    const step = `SELECT ${next} FROM ${SPINE_SEQ_CTE} WHERE ${next} <= ${endExpr}`;
    return {
      from: SPINE_SEQ_CTE,
      ctes: [`${SPINE_SEQ_CTE} AS (\n  ${seed}\n  UNION ALL\n  ${step}\n)`],
      recursive: true
    };
  }

  public periodDiff(grain: TimeGrain, later: string, earlier: string): string {
    return `TIMESTAMPDIFF(${calendarGrain(grain).toUpperCase()}, ${earlier}, ${later})`;
  }
}

export const mysql = new MySqlDialect();
