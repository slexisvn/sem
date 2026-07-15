import { TimeGrain } from "../config/constants.js";
import { BaseDialect } from "./dialect.js";

export class PostgresDialect extends BaseDialect {
  public readonly name = "postgres";

  protected quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  public paramPlaceholder(index1: number): string {
    return `$${index1}`;
  }

  public truncTime(grain: TimeGrain, expr: string): string {
    return `DATE_TRUNC('${grain}', ${expr})`;
  }

  public periodSeries(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): string {
    return `generate_series(${startExpr}, ${endExpr}, INTERVAL '1 ${grain}') AS ${this.ident(columnAlias)}`;
  }
}

export const postgres = new PostgresDialect();
