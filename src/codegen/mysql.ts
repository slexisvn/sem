import { TimeGrain } from "../config/constants.js";
import { BaseDialect, lateralAsOf, quoteZone } from "./dialect.js";

const UTC = "'UTC'";

export class MySqlDialect extends BaseDialect {
  public readonly name = "mysql";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string, tz?: string): string {
    const local = tz === undefined ? expr : `CONVERT_TZ(${expr}, ${UTC}, ${quoteZone(tz)})`;
    switch (grain) {
      case TimeGrain.Day:
        return `DATE(${local})`;
      case TimeGrain.Week:
        return `STR_TO_DATE(CONCAT(YEARWEEK(${local}, 3), ' Monday'), '%X%V %W')`;
      case TimeGrain.Month:
        return `DATE_FORMAT(${local}, '%Y-%m-01')`;
      case TimeGrain.Quarter:
        return `STR_TO_DATE(CONCAT(YEAR(${local}), '-', LPAD(((QUARTER(${local}) - 1) * 3 + 1), 2, '0'), '-01'), '%Y-%m-%d')`;
      case TimeGrain.Year:
        return `DATE_FORMAT(${local}, '%Y-01-01')`;
    }
  }

  public asOfLateral(table: string, alias: string, keyPred: string, tsPred: string, order: string): string {
    return lateralAsOf(table, alias, keyPred, tsPred, order);
  }

  public periodDiff(grain: TimeGrain, later: string, earlier: string): string {
    return `TIMESTAMPDIFF(${grain.toUpperCase()}, ${earlier}, ${later})`;
  }
}

export const mysql = new MySqlDialect();
