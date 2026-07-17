import { analyze } from "../analyzer/analyzer.js";
import { Catalog } from "../analyzer/catalog.js";
import { AssertDecl, AssertExpectation, NodeKind, QueryDecl } from "../ast/nodes.js";
import { printRef } from "../ast/print.js";
import { generate } from "../codegen/codegen.js";
import { SqlDialect } from "../codegen/dialect.js";
import { postgres } from "../codegen/postgres.js";

export interface CompiledAssert {
  readonly metric: string;
  readonly sql: string;
  readonly params: (string | number | boolean)[];
  readonly expectation: AssertExpectation;
}

export function compileAssert(catalog: Catalog, decl: AssertDecl, dialect: SqlDialect = postgres): CompiledAssert {
  const query: QueryDecl = {
    kind: NodeKind.Query,
    metrics: [{ kind: NodeKind.SelectItem, expr: decl.metric, span: decl.metric.span }],
    dimensions: [],
    where: decl.where,
    span: decl.span
  };
  const plan = analyze(catalog, query);
  const result = generate(catalog, plan, dialect);
  return {
    metric: printRef(decl.metric.base),
    sql: result.sql,
    params: result.params,
    expectation: decl.expectation
  };
}

export function compileAsserts(catalog: Catalog, decls: AssertDecl[], dialect: SqlDialect = postgres): CompiledAssert[] {
  return decls.map((decl) => compileAssert(catalog, decl, dialect));
}
