import { analyze, AnalyzeOptions } from "../analyzer/analyzer.js";
import { Catalog } from "../analyzer/catalog.js";
import { generate } from "../codegen/codegen.js";
import { SqlDialect } from "../codegen/dialect.js";
import { postgres } from "../codegen/postgres.js";
import { parseQuery } from "../parser/parser.js";

export interface MaterializeOptions extends AnalyzeOptions {
  readonly dialect?: SqlDialect;
}

export function materialize(
  catalog: Catalog,
  name: string,
  querySource: string,
  options: MaterializeOptions = {}
): string {
  const dialect = options.dialect ?? postgres;
  const plan = analyze(catalog, parseQuery(querySource), options);
  const { sql, params } = generate(catalog, plan, dialect);
  const body = inlineParams(sql.replace(/;\s*$/, ""), params);
  return `CREATE MATERIALIZED VIEW ${dialect.ident(name)} AS\n${body};`;
}

function inlineParams(sql: string, params: (string | number | boolean)[]): string {
  return sql.replace(/\$(\d+)/g, (_match, digits: string) => {
    const value = params[Number(digits) - 1];
    return value === undefined ? `$${digits}` : literal(value);
  });
}

function literal(value: string | number | boolean): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
}
