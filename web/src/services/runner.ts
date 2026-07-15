import { createEngine, registerTable } from "@slexisvn/query-engine";
import type { CompiledSql, DataTable, ResultSet, SqlRunner } from "../domain/types.js";

export class QueryEngineRunner implements SqlRunner {
  async run(compiled: CompiledSql, tables: Iterable<DataTable>): Promise<ResultSet> {
    const engine = createEngine();
    for (const table of tables) registerTable(engine, table.name, table.rows);
    const result = await engine.run(compiled.sql, compiled.params);
    return { columns: result.columns, rows: result.rows };
  }
}
