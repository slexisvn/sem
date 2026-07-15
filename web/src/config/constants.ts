export const CSV = {
  extensions: [".csv", ".tsv"],
  delimiters: { ".csv": ",", ".tsv": "\t" } as Record<string, string>,
  defaultDelimiter: ",",
  quote: '"',
  nullTokens: ["", "null", "na", "nan"],
  booleanTokens: { true: true, false: false } as Record<string, boolean>,
  numberPattern: /^-?\d+(\.\d+)?$/,
} as const;

export const NAMING = {
  fallbackTable: "table",
  invalidChars: /[^a-zA-Z0-9_]/g,
  collapse: /_+/g,
  trimEdges: /^_|_$/g,
  extension: /\.[^.]+$/,
} as const;

export const DISPLAY = {
  nullGlyph: "∅",
  maxRenderedRows: 500,
  dataPageSize: 25,
} as const;

export const SHORTCUTS = {
  run: { key: "Enter", withMeta: true },
} as const;

export const LABELS = {
  title: "sem playground",
  subtitle: "type sem · compile to sql · run on your csv",
  schema: "Schema",
  query: "Query",
  data: "Data",
  sql: "Compiled SQL",
  result: "Result",
  compile: "Compile",
  run: "Run",
  sample: "Load sample",
  drop: "Drop CSV files or click to browse",
  emptyTables: "No tables yet. Upload a CSV or load the sample.",
  emptyData: "No rows to preview.",
  emptySql: "Compile a query to see SQL.",
  emptyResult: "Run compiled SQL to see results.",
  noRows: "Query returned no rows.",
  previous: "Prev",
  next: "Next",
  pageRange: (start: number, end: number, total: number) => `${start}-${end} of ${total}`,
  rowUnit: (n: number) => `${n} row${n === 1 ? "" : "s"}`,
} as const;
