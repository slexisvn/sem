import { TimeGrain } from "../config/constants.js";
import { BaseDialect, quoteZone } from "./dialect.js";

export class BigQueryDialect extends BaseDialect {
  public readonly name = "bigquery";

  protected quote(name: string): string {
    return `\`${name.replace(/`/g, "")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string, tz?: string): string {
    if (tz === undefined) return `DATE_TRUNC(${expr}, ${grain.toUpperCase()})`;
    return `TIMESTAMP_TRUNC(${expr}, ${grain.toUpperCase()}, ${quoteZone(tz)})`;
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): string {
    return `UNNEST(GENERATE_DATE_ARRAY(${startExpr}, ${endExpr}, INTERVAL 1 ${grain.toUpperCase()})) AS ${this.ident(columnAlias)}`;
  }

  public periodDiff(grain: TimeGrain, later: string, earlier: string): string {
    return `DATE_DIFF(DATE(${later}), DATE(${earlier}), ${grain.toUpperCase()})`;
  }

  public approxQuantile(argSql: string, fraction: number): string {
    return `APPROX_QUANTILES(${argSql}, 100)[OFFSET(${Math.round(fraction * 100)})]`;
  }
}

export const bigquery = new BigQueryDialect();
