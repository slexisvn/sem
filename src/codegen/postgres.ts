import { TimeGrain } from "../config/constants.js";
import { SqlDialect } from "./dialect.js";

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;

export class PostgresDialect implements SqlDialect {
  public readonly name = "postgres";

  public ident(name: string): string {
    return SIMPLE_IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
  }

  public paramPlaceholder(index1: number): string {
    return `$${index1}`;
  }

  public truncTime(grain: TimeGrain, expr: string): string {
    return `DATE_TRUNC('${grain}', ${expr})`;
  }

  public limit(n: number): string {
    return `LIMIT ${n}`;
  }
}

export const postgres = new PostgresDialect();
