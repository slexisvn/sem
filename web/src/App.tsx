import { useLayoutEffect, useRef, useState } from "react";
import { usePlayground } from "./hooks/usePlayground.js";
import { LABELS } from "./config/constants.js";
import { Panel } from "./components/Panel.js";
import { Editor } from "./components/Editor.js";
import { DataPanel } from "./components/DataPanel.js";
import { SqlPanel } from "./components/SqlPanel.js";
import { ResultTable } from "./components/ResultTable.js";
import { StatusBar } from "./components/StatusBar.js";
import { Docs } from "./components/Docs.js";

type View = "play" | "docs";

export function App() {
  const pg = usePlayground();
  const editorStackRef = useRef<HTMLDivElement>(null);
  const [sqlHeight, setSqlHeight] = useState<number>();
  const [view, setView] = useState<View>("play");

  useLayoutEffect(() => {
    const element = editorStackRef.current;
    if (!element) return;

    const measure = () => setSqlHeight(element.getBoundingClientRect().height);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="app">
      <header className="app__head">
        <div>
          <h1>{LABELS.title}</h1>
          <p className="muted">{LABELS.subtitle}</p>
        </div>
        <nav className="app__nav" aria-label="View">
          <button
            type="button"
            className={`tab ${view === "play" ? "tab--active" : ""}`}
            onClick={() => setView("play")}
          >
            Playground
          </button>
          <button
            type="button"
            className={`tab ${view === "docs" ? "tab--active" : ""}`}
            onClick={() => setView("docs")}
          >
            Docs
          </button>
        </nav>
      </header>

      {view === "docs" ? (
        <Docs />
      ) : (
        <>
      <StatusBar status={pg.status} />

      <div className="grid">
        <div className="col">
          <div className="editorStack" ref={editorStackRef}>
            <Panel title={LABELS.schema}>
              <Editor value={pg.schema} onChange={pg.setSchema} onSubmit={pg.compile} rows={14} />
            </Panel>
            <Panel title={LABELS.query}>
              <Editor value={pg.query} onChange={pg.setQuery} onSubmit={pg.compile} rows={3} />
            </Panel>
          </div>
          <DataPanel
            tables={pg.tables}
            onFiles={pg.addFiles}
            onRemove={pg.removeTable}
            onLoadSample={pg.loadSample}
          />
        </div>

        <div className="col">
          <SqlPanel compiled={pg.compiled} onCompile={pg.compile} busy={pg.busy} height={sqlHeight} />
          <ResultTable result={pg.result} onRun={pg.run} busy={pg.busy} canRun={Boolean(pg.compiled)} />
        </div>
      </div>
        </>
      )}
    </div>
  );
}
