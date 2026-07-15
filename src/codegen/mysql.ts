import { TimeGrain } from "../config/constants.js";
import { BaseDialect } from "./dialect.js";

export class MySqlDialect extends BaseDialect {
  public readonly name = "mysql";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string): string {
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
}

export const mysql = new MySqlDialect();
