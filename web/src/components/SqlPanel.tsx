import { Panel } from "./Panel.js";
import { LABELS } from "../config/constants.js";
import type { CompiledSql } from "../domain/types.js";
import { highlightCode } from "../services/highlight.js";

interface SqlPanelProps {
  compiled: CompiledSql | null;
  onCompile: () => void;
  busy: boolean;
}

function render(compiled: CompiledSql): string {
  const params = compiled.params.length ? `\n\n-- params: ${JSON.stringify(compiled.params)}` : "";
  return compiled.sql + params;
}

export function SqlPanel({ compiled, onCompile, busy }: SqlPanelProps) {
  return (
    <Panel
      title={LABELS.sql}
      actions={
        <button className="btn" onClick={onCompile} disabled={busy}>
          {LABELS.compile}
        </button>
      }
    >
      {compiled ? (
        <pre
          className="code"
          dangerouslySetInnerHTML={{ __html: highlightCode(render(compiled), "sql") }}
        />
      ) : (
        <p className="muted">{LABELS.emptySql}</p>
      )}
    </Panel>
  );
}
