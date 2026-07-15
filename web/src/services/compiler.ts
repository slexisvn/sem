import { compile } from "../../../dist/index.js";
import { format } from "sql-formatter";
import type { Cell, CompiledSql, SqlCompiler } from "../domain/types.js";

function formatSql(sql: string): string {
  try {
    return format(sql, {
      language: "postgresql",
      keywordCase: "upper",
      linesBetweenQueries: 1,
      tabWidth: 2,
    });
  } catch {
    return sql;
  }
}

export class SemCompiler implements SqlCompiler {
  compile(schema: string, query: string): CompiledSql {
    const result = compile(schema, query);
    return { sql: formatSql(result.sql), params: (result.params ?? []) as readonly Cell[] };
  }
}
