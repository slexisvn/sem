export type Cell = string | number | boolean | null;

export interface DataTable {
  name: string;
  columns: string[];
  rows: Record<string, Cell>[];
}

export interface CompiledSql {
  sql: string;
  params: readonly Cell[];
}

export interface ResultSet {
  columns: string[];
  rows: Record<string, Cell>[];
}

export type StatusKind = "idle" | "info" | "success" | "error";

export interface Status {
  kind: StatusKind;
  message: string;
}

export interface SqlCompiler {
  compile(schema: string, query: string): CompiledSql;
}

export interface DataSource {
  accepts(file: File): boolean;
  load(file: File): Promise<DataTable>;
}

export interface SqlRunner {
  run(compiled: CompiledSql, tables: Iterable<DataTable>): Promise<ResultSet>;
}
