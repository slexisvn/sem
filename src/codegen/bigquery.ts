import { TimeGrain } from "../config/constants.js";
import { SqlDialect } from "./dialect.js";

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;

export class BigQueryDialect implements SqlDialect {
  public readonly name = "bigquery";

  public ident(name: string): string {
    return SIMPLE_IDENT.test(name) ? name : `\`${name.replace(/`/g, "")}\``;
  }

  public paramPlaceholder(_index1: number): string {
    return "?";
  }

  public truncTime(grain: TimeGrain, expr: string): string {
    return `DATE_TRUNC(${expr}, ${grain.toUpperCase()})`;
  }

  public limit(n: number): string {
    return `LIMIT ${n}`;
  }
}

export const bigquery = new BigQueryDialect();
