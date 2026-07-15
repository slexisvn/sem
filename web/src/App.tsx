import { usePlayground } from "./hooks/usePlayground.js";
import { LABELS } from "./config/constants.js";
import { Panel } from "./components/Panel.js";
import { Editor } from "./components/Editor.js";
import { DataPanel } from "./components/DataPanel.js";
import { SqlPanel } from "./components/SqlPanel.js";
import { ResultTable } from "./components/ResultTable.js";
import { StatusBar } from "./components/StatusBar.js";

export function App() {
  const pg = usePlayground();

  return (
    <div className="app">
      <header className="app__head">
        <div>
          <h1>{LABELS.title}</h1>
          <p className="muted">{LABELS.subtitle}</p>
        </div>
      </header>

      <StatusBar status={pg.status} />

      <div className="grid">
        <div className="col">
          <Panel title={LABELS.schema}>
            <Editor value={pg.schema} onChange={pg.setSchema} onSubmit={pg.compile} rows={14} />
          </Panel>
          <Panel title={LABELS.query}>
            <Editor value={pg.query} onChange={pg.setQuery} onSubmit={pg.compile} rows={3} />
          </Panel>
          <DataPanel
            tables={pg.tables}
            onFiles={pg.addFiles}
            onRemove={pg.removeTable}
            onLoadSample={pg.loadSample}
          />
        </div>

        <div className="col">
          <SqlPanel compiled={pg.compiled} onCompile={pg.compile} busy={pg.busy} />
          <ResultTable result={pg.result} onRun={pg.run} busy={pg.busy} canRun={Boolean(pg.compiled)} />
        </div>
      </div>
    </div>
  );
}
