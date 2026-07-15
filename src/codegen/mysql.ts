import { TimeGrain } from "../config/constants.js";
import { SqlDialect } from "./dialect.js";

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;

export class MySqlDialect implements SqlDialect {
  public readonly name = "mysql";

  public ident(name: string): string {
    return SIMPLE_IDENT.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string): string {
    switch (grain) {
      case TimeGrain.Day:
        return `DATE(${expr})`;
      case TimeGrain.Week:
        // ISO week start; keeps week grouping stable across year boundaries.
        return `STR_TO_DATE(CONCAT(YEARWEEK(${expr}, 3), ' Monday'), '%X%V %W')`;
      case TimeGrain.Month:
        return `DATE_FORMAT(${expr}, '%Y-%m-01')`;
      case TimeGrain.Quarter:
        return `STR_TO_DATE(CONCAT(YEAR(${expr}), '-', LPAD(((QUARTER(${expr}) - 1) * 3 + 1), 2, '0'), '-01'), '%Y-%m-%d')`;
      case TimeGrain.Year:
        return `DATE_FORMAT(${expr}, '%Y-01-01')`;
    }
  }

  public limit(n: number): string {
    return `LIMIT ${n}`;
  }
}

export const mysql = new MySqlDialect();
