import { createEngine, registerTable } from "@slexisvn/query-engine";
import type { Cell, CompiledSql, DataTable, ResultSet, SqlRunner } from "../domain/types.js";

function toCell(value: unknown): Cell {
  // The engine can return bigint for integer columns; the UI works in Cell values.
  if (typeof value === "bigint") return Number(value);
  return value as Cell;
}

export class QueryEngineRunner implements SqlRunner {
  async run(compiled: CompiledSql, tables: Iterable<DataTable>): Promise<ResultSet> {
    const engine = createEngine();
    for (const table of tables) registerTable(engine, table.name, table.rows);
    const result = await engine.run(compiled.sql, compiled.params);
    const rows = result.rows.map((row) => {
      const record: Record<string, Cell> = {};
      for (const key of Object.keys(row)) record[key] = toCell(row[key]);
      return record;
    });
    return { columns: result.columns, rows };
  }
}
