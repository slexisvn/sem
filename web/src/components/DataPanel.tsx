import { useEffect, useMemo, useState } from "react";
import { Panel } from "./Panel.js";
import { FileDrop } from "./FileDrop.js";
import { DISPLAY, LABELS } from "../config/constants.js";
import type { Cell, DataTable } from "../domain/types.js";

interface DataPanelProps {
  tables: DataTable[];
  onFiles: (files: File[]) => void;
  onRemove: (name: string) => void;
  onLoadSample: () => void;
}

function formatCell(value: Cell): string {
  return value === null || value === undefined ? DISPLAY.nullGlyph : String(value);
}

function DataPreview({ table }: { table: DataTable }) {
  const [page, setPage] = useState(0);
  const pageSize = DISPLAY.dataPageSize;
  const pageCount = Math.max(1, Math.ceil(table.rows.length / pageSize));
  const hasPagination = table.rows.length > pageSize;
  const safePage = Math.min(page, pageCount - 1);
  const start = hasPagination ? safePage * pageSize : 0;
  const rows = useMemo(
    () => table.rows.slice(start, hasPagination ? start + pageSize : undefined),
    [hasPagination, start, table.rows, pageSize]
  );

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  if (table.rows.length === 0) {
    return <p className="muted">{LABELS.emptyData}</p>;
  }

  const rangeStart = start + 1;
  const rangeEnd = start + rows.length;

  return (
    <div className="dataPreview">
      <div className="tablewrap tablewrap--preview">
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={start + index}>
                {table.columns.map((column) => (
                  <td key={column}>{formatCell(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasPagination ? (
        <div className="pager">
          <span className="muted">{LABELS.pageRange(rangeStart, rangeEnd, table.rows.length)}</span>
          <div className="pager__buttons">
            <button
              className="btn btn--ghost"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={safePage === 0}
            >
              {LABELS.previous}
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={safePage >= pageCount - 1}
            >
              {LABELS.next}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DataPanel({ tables, onFiles, onRemove, onLoadSample }: DataPanelProps) {
  return (
    <Panel
      title={LABELS.data}
      actions={
        <button className="btn btn--ghost" onClick={onLoadSample}>
          {LABELS.sample}
        </button>
      }
    >
      <FileDrop onFiles={onFiles} />
      {tables.length === 0 ? (
        <p className="muted">{LABELS.emptyTables}</p>
      ) : (
        <ul className="chips">
          {tables.map((table) => (
            <li key={table.name} className="chip">
              <div className="chip__head">
                <code>{table.name}</code>
                <span className="muted">{LABELS.rowUnit(table.rows.length)}</span>
                <button className="chip__x" onClick={() => onRemove(table.name)} aria-label="Remove">
                  ×
                </button>
              </div>
              <DataPreview table={table} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
