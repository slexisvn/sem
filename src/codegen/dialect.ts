import { TimeGrain } from "../config/constants.js";

export interface SqlDialect {
  readonly name: string;
  ident(name: string): string;
  qualifiedName(dotted: string): string;
  paramPlaceholder(index1: number): string;
  truncTime(grain: TimeGrain, expr: string): string;
  limit(n: number): string;
  periodSeries?(grain: TimeGrain, startExpr: string, endExpr: string, columnAlias: string): string;
  orderedQuantile?(argSql: string, fraction: number): string;
  asOfLateral?(table: string, alias: string, keyPred: string, tsPred: string, order: string): string;
  periodDiff?(grain: TimeGrain, later: string, earlier: string): string;
}

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;

export abstract class BaseDialect implements SqlDialect {
  public abstract readonly name: string;

  protected abstract quote(name: string): string;
  public abstract paramPlaceholder(index1: number): string;
  public abstract truncTime(grain: TimeGrain, expr: string): string;

  public ident(name: string): string {
    return SIMPLE_IDENT.test(name) ? name : this.quote(name);
  }

  public qualifiedName(dotted: string): string {
    return dotted
      .split(".")
      .map((part) => this.ident(part))
      .join(".");
  }

  public limit(n: number): string {
    return `LIMIT ${n}`;
  }
}
