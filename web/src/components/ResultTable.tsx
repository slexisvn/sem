import { Panel } from "./Panel.js";
import { DISPLAY, LABELS } from "../config/constants.js";
import type { Cell, ResultSet } from "../domain/types.js";

interface ResultTableProps {
  result: ResultSet | null;
  onRun: () => void;
  busy: boolean;
  canRun: boolean;
}

function formatCell(value: Cell): string {
  return value === null || value === undefined ? DISPLAY.nullGlyph : String(value);
}

function runButton(onRun: () => void, busy: boolean, canRun: boolean) {
  return (
    <button className="btn" onClick={onRun} disabled={busy || !canRun}>
      {LABELS.run}
    </button>
  );
}

export function ResultTable({ result, onRun, busy, canRun }: ResultTableProps) {
  const actions = runButton(onRun, busy, canRun);

  if (!result)
    return (
      <Panel title={LABELS.result} actions={actions} grow>
        <p className="muted">{LABELS.emptyResult}</p>
      </Panel>
    );
  if (result.rows.length === 0)
    return (
      <Panel title={LABELS.result} actions={actions} grow>
        <p className="muted">{LABELS.noRows}</p>
      </Panel>
    );

  const rows = result.rows.slice(0, DISPLAY.maxRenderedRows);

  return (
    <Panel title={LABELS.result} actions={actions} grow>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {result.columns.map((column) => (
                  <td key={column}>{formatCell(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
