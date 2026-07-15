import { TimeGrain } from "../config/constants.js";

export interface SqlDialect {
  readonly name: string;
  ident(name: string): string;
  paramPlaceholder(index1: number): string;
  truncTime(grain: TimeGrain, expr: string): string;
  limit(n: number): string;
}
