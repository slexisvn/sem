import { ModelDecl, Program, QueryDecl } from "./ast/nodes.js";
import { analyze, analyzeFunnel, analyzeRetention, AnalyzeOptions } from "./analyzer/analyzer.js";
import { Catalog } from "./analyzer/catalog.js";
import { checkRollups, route } from "./analyzer/routing.js";
import { FunnelPlan, Plan, RetentionPlan, SqlResult } from "./analyzer/ir.js";
import { generate, generateFunnel, generateRetention } from "./codegen/codegen.js";
import { SqlDialect } from "./codegen/dialect.js";
import { postgres } from "./codegen/postgres.js";
import { parseFunnel, parseProgram, parseQuery, parseRetention } from "./parser/parser.js";
import { tokenize } from "./lexer/lexer.js";
import { TokKind } from "./lexer/token.js";

export * from "./lexer/token.js";
export * from "./config/constants.js";
export * from "./config/aggregates.js";
export * from "./diagnostics/diagnostic.js";
export * from "./ast/nodes.js";
export { tokenize, Lexer } from "./lexer/lexer.js";
export { Parser, parseModels, parseProgram, parseQuery, parseFunnel, parseRetention } from "./parser/parser.js";
export { Catalog } from "./analyzer/catalog.js";
export type { DimInfo, MaterializationInfo, MeasureInfo, MetricInfo, JoinInfo, ModelInfo, PolicyInfo } from "./analyzer/catalog.js";
export { Analyzer, analyze, analyzeFunnel, analyzeRetention } from "./analyzer/analyzer.js";
export type { AnalyzeOptions } from "./analyzer/analyzer.js";
export { checkRollups, route } from "./analyzer/routing.js";
export type { RoutedPlan } from "./analyzer/routing.js";
export * from "./analyzer/ir.js";
export type { SqlDialect } from "./codegen/dialect.js";
export { PostgresDialect, postgres } from "./codegen/postgres.js";
export { BigQueryDialect, bigquery } from "./codegen/bigquery.js";
export { MySqlDialect, mysql } from "./codegen/mysql.js";
export { Generator, generate, generateFunnel, generateRetention } from "./codegen/codegen.js";
export { compileAssert, compileAsserts } from "./tools/assertions.js";
export type { CompiledAssert } from "./tools/assertions.js";
export { materialize, materializeDecl } from "./tools/materialize.js";
export type { MaterializeOptions } from "./tools/materialize.js";
export { generateDocs, SymbolService } from "./tools/symbols.js";
export type { Symbol as SemSymbol, SymbolKind } from "./tools/symbols.js";

export function buildCatalog(models: ModelDecl[]): Catalog {
  return Catalog.build(models);
}

export function catalogFromSource(source: string): Catalog {
  const program = parseProgram(source);
  const catalog = Catalog.build(program.models, program.policies, program.materializes);
  checkRollups(catalog);
  return catalog;
}

export interface Compiled extends SqlResult {
  readonly plan: Plan | FunnelPlan | RetentionPlan;
  readonly routedTo?: string;
}

export interface CompileOptions extends AnalyzeOptions {
  readonly dialect?: SqlDialect;
}

export function compile(modelSource: string, querySource: string, options: CompileOptions = {}): Compiled {
  return compileWithCatalog(catalogFromSource(modelSource), querySource, options);
}

export function compileWithCatalog(
  catalog: Catalog,
  querySource: string,
  options: CompileOptions = {}
): Compiled {
  const dialect = options.dialect ?? postgres;
  const lead = leadingKind(querySource);
  if (lead === TokKind.Funnel) {
    const plan = analyzeFunnel(catalog, parseFunnel(querySource));
    return { ...generateFunnel(catalog, plan, dialect), plan };
  }
  if (lead === TokKind.Retention) {
    const plan = analyzeRetention(catalog, parseRetention(querySource));
    return { ...generateRetention(catalog, plan, dialect), plan };
  }
  const query = parseQuery(querySource);
  const plan = analyze(catalog, query, options);
  const routed = route(catalog, plan, query.span);
  const chosen = routed?.plan ?? plan;
  return { ...generate(catalog, chosen, dialect), plan: chosen, routedTo: routed?.materialization };
}

function leadingKind(source: string): TokKind | undefined {
  const tokens = tokenize(source);
  return tokens.length > 0 ? tokens[0]!.kind : undefined;
}

export type { ModelDecl, Program, QueryDecl };
