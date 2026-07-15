import { ModelDecl, Program, QueryDecl } from "./ast/nodes.js";
import { analyze, AnalyzeOptions } from "./analyzer/analyzer.js";
import { Catalog } from "./analyzer/catalog.js";
import { Plan, SqlResult } from "./analyzer/ir.js";
import { generate } from "./codegen/codegen.js";
import { SqlDialect } from "./codegen/dialect.js";
import { postgres } from "./codegen/postgres.js";
import { parseProgram, parseQuery } from "./parser/parser.js";

export * from "./lexer/token.js";
export * from "./config/constants.js";
export * from "./diagnostics/diagnostic.js";
export * from "./ast/nodes.js";
export { tokenize, Lexer } from "./lexer/lexer.js";
export { Parser, parseModels, parseProgram, parseQuery } from "./parser/parser.js";
export { Catalog } from "./analyzer/catalog.js";
export type { DimInfo, MeasureInfo, MetricInfo, JoinInfo, ModelInfo, PolicyInfo } from "./analyzer/catalog.js";
export { Analyzer, analyze } from "./analyzer/analyzer.js";
export type { AnalyzeOptions } from "./analyzer/analyzer.js";
export * from "./analyzer/ir.js";
export type { SqlDialect } from "./codegen/dialect.js";
export { PostgresDialect, postgres } from "./codegen/postgres.js";
export { BigQueryDialect, bigquery } from "./codegen/bigquery.js";
export { Generator, generate } from "./codegen/codegen.js";
export { compileAssert, compileAsserts } from "./tools/assertions.js";
export type { CompiledAssert } from "./tools/assertions.js";
export { materialize } from "./tools/materialize.js";
export { generateDocs, SymbolService } from "./tools/symbols.js";
export type { Symbol as SemSymbol, SymbolKind } from "./tools/symbols.js";

export function buildCatalog(models: ModelDecl[]): Catalog {
  return Catalog.build(models);
}

export function catalogFromSource(source: string): Catalog {
  const program = parseProgram(source);
  return Catalog.build(program.models, program.policies);
}

export interface Compiled extends SqlResult {
  readonly plan: Plan;
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
  const plan = analyze(catalog, parseQuery(querySource), options);
  const result = generate(catalog, plan, dialect);
  return { ...result, plan };
}

export type { ModelDecl, Program, QueryDecl };
