import { useCallback, useMemo, useReducer } from "react";
import type { CompiledSql, DataTable, ResultSet, Status } from "../domain/types.js";
import { LABELS } from "../config/constants.js";
import { DEFAULT_QUERY, DEFAULT_SCHEMA, SAMPLE_DATASET } from "../config/samples.js";
import { createServices, resolveDataSource, type Services } from "../services/index.js";
import { parseCsvText } from "../services/csv.js";

interface State {
  schema: string;
  query: string;
  tables: Map<string, DataTable>;
  compiled: CompiledSql | null;
  result: ResultSet | null;
  busy: boolean;
  status: Status;
}

type Action =
  | { type: "schema"; value: string }
  | { type: "query"; value: string }
  | { type: "tables"; value: DataTable[] }
  | { type: "removeTable"; name: string }
  | { type: "compiled"; value: CompiledSql }
  | { type: "result"; value: ResultSet | null }
  | { type: "busy"; value: boolean }
  | { type: "status"; value: Status };

const initialState: State = {
  schema: DEFAULT_SCHEMA,
  query: DEFAULT_QUERY,
  tables: new Map(),
  compiled: null,
  result: null,
  busy: false,
  status: { kind: "idle", message: "" },
};

function withTables(current: Map<string, DataTable>, incoming: DataTable[]): Map<string, DataTable> {
  const next = new Map(current);
  for (const table of incoming) next.set(table.name, table);
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "schema":
      return { ...state, schema: action.value, compiled: null, result: null };
    case "query":
      return { ...state, query: action.value, compiled: null, result: null };
    case "tables":
      return { ...state, tables: withTables(state.tables, action.value) };
    case "removeTable": {
      const next = new Map(state.tables);
      next.delete(action.name);
      return { ...state, tables: next };
    }
    case "compiled":
      return { ...state, compiled: action.value };
    case "result":
      return { ...state, result: action.value };
    case "busy":
      return { ...state, busy: action.value };
    case "status":
      return { ...state, status: action.value };
  }
}

export function usePlayground(services: Services = createServices()) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setStatus = useCallback((status: Status) => dispatch({ type: "status", value: status }), []);

  const setSchema = useCallback((value: string) => dispatch({ type: "schema", value }), []);
  const setQuery = useCallback((value: string) => dispatch({ type: "query", value }), []);

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const loaded: DataTable[] = [];
      for (const file of files) {
        const source = resolveDataSource(services.dataSources, file);
        if (!source) {
          setStatus({ kind: "error", message: `Unsupported file "${file.name}".` });
          continue;
        }
        try {
          loaded.push(await source.load(file));
        } catch (error) {
          setStatus({ kind: "error", message: (error as Error).message });
        }
      }
      if (loaded.length > 0) {
        dispatch({ type: "tables", value: loaded });
        const total = loaded.reduce((sum, t) => sum + t.rows.length, 0);
        setStatus({
          kind: "success",
          message: `Loaded ${loaded.length} table(s), ${LABELS.rowUnit(total)}.`,
        });
      }
    },
    [services, setStatus]
  );

  const removeTable = useCallback((name: string) => dispatch({ type: "removeTable", name }), []);

  const loadSample = useCallback(() => {
    const table = parseCsvText(
      SAMPLE_DATASET.fileName.replace(/\.[^.]+$/, ""),
      SAMPLE_DATASET.content
    );
    dispatch({ type: "tables", value: [table] });
    setStatus({ kind: "success", message: `Loaded sample "${table.name}".` });
  }, [setStatus]);

  const compile = useCallback(() => {
    dispatch({ type: "busy", value: true });
    try {
      const compiled = services.compiler.compile(state.schema, state.query);
      dispatch({ type: "compiled", value: compiled });
      dispatch({ type: "result", value: null });
      setStatus({ kind: "success", message: "SQL compiled." });
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    } finally {
      dispatch({ type: "busy", value: false });
    }
  }, [services, state.schema, state.query, setStatus]);

  const run = useCallback(async () => {
    if (!state.compiled) {
      setStatus({ kind: "info", message: "Compile SQL before running it." });
      return;
    }

    dispatch({ type: "busy", value: true });
    try {
      if (state.tables.size === 0) {
        setStatus({ kind: "info", message: "Add data to run the compiled SQL." });
        return;
      }
      const result = await services.runner.run(state.compiled, state.tables.values());
      dispatch({ type: "result", value: result });
      setStatus({ kind: "success", message: `Executed — ${LABELS.rowUnit(result.rows.length)}.` });
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    } finally {
      dispatch({ type: "busy", value: false });
    }
  }, [services, state.compiled, state.tables, setStatus]);

  const tableList = useMemo(() => [...state.tables.values()], [state.tables]);

  return {
    schema: state.schema,
    query: state.query,
    tables: tableList,
    compiled: state.compiled,
    result: state.result,
    status: state.status,
    busy: state.busy,
    setSchema,
    setQuery,
    addFiles,
    removeTable,
    loadSample,
    compile,
    run,
  };
}
