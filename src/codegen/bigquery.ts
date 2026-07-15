import { TimeGrain } from "../config/constants.js";
import { BaseDialect } from "./dialect.js";

export class BigQueryDialect extends BaseDialect {
  public readonly name = "bigquery";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string): string {
    return `DATE_TRUNC(${expr}, ${grain.toUpperCase()})`;
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): string {
    return `UNNEST(GENERATE_DATE_ARRAY(${startExpr}, ${endExpr}, INTERVAL 1 ${grain.toUpperCase()})) AS ${this.ident(columnAlias)}`;
  }
}

export const bigquery = new BigQueryDialect();
