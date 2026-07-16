import { CSV, NAMING } from "../config/constants.js";
import type { Cell, DataSource, DataTable } from "../domain/types.js";

function detectDelimiter(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return CSV.delimiters[ext] ?? CSV.defaultDelimiter;
}

function splitGrid(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const push = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === CSV.quote) {
        if (text[i + 1] === CSV.quote) {
          cell += CSV.quote;
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === CSV.quote) quoted = true;
    else if (ch === delimiter) push();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length > 0 || row.length > 0) endRow();
  return rows;
}

function coerce(raw: string): Cell {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if ((CSV.nullTokens as readonly string[]).includes(lower)) return null;
  if (lower in CSV.booleanTokens) return CSV.booleanTokens[lower];
  if (CSV.numberPattern.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function tableName(fileName: string): string {
  const base = fileName.replace(NAMING.extension, "");
  const cleaned = base
    .replace(NAMING.invalidChars, "_")
    .replace(NAMING.collapse, "_")
    .replace(NAMING.trimEdges, "");
  return cleaned || NAMING.fallbackTable;
}

function toTable(name: string, grid: string[][]): DataTable {
  const [header, ...body] = grid.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  const columns = (header ?? []).map((h) => h.trim());
  const rows = body.map((cells) => {
    const record: Record<string, Cell> = {};
    for (let i = 0; i < columns.length; i++) record[columns[i]] = coerce(cells[i] ?? "");
    return record;
  });
  return { name, columns, rows };
}

export class CsvDataSource implements DataSource {
  accepts(file: File): boolean {
    const lower = file.name.toLowerCase();
    return CSV.extensions.some((ext) => lower.endsWith(ext));
  }

  async load(file: File): Promise<DataTable> {
    const text = await file.text();
    const grid = splitGrid(text, detectDelimiter(file.name));
    const table = toTable(tableName(file.name), grid);
    if (table.columns.length === 0) throw new Error(`"${file.name}" has no header row.`);
    return table;
  }
}

export function parseCsvText(name: string, text: string, delimiter = CSV.defaultDelimiter): DataTable {
  return toTable(name, splitGrid(text, delimiter));
}
