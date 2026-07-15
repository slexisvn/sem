import type { DataSource, SqlCompiler, SqlRunner } from "../domain/types.js";
import { CsvDataSource } from "./csv.js";
import { SemCompiler } from "./compiler.js";
import { QueryEngineRunner } from "./runner.js";

export interface Services {
  compiler: SqlCompiler;
  runner: SqlRunner;
  dataSources: DataSource[];
}

export function createServices(overrides: Partial<Services> = {}): Services {
  return {
    compiler: overrides.compiler ?? new SemCompiler(),
    runner: overrides.runner ?? new QueryEngineRunner(),
    dataSources: overrides.dataSources ?? [new CsvDataSource()],
  };
}

export function resolveDataSource(sources: DataSource[], file: File): DataSource | undefined {
  return sources.find((source) => source.accepts(file));
}
