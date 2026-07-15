import type { KeyboardEvent, UIEvent } from "react";
import { useMemo, useRef } from "react";
import { SHORTCUTS } from "../config/constants.js";
import { highlightCode } from "../services/highlight.js";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  rows?: number;
  spellCheck?: boolean;
  language?: "sem";
}

function isRunShortcut(event: KeyboardEvent): boolean {
  const meta = event.metaKey || event.ctrlKey;
  return event.key === SHORTCUTS.run.key && meta === SHORTCUTS.run.withMeta;
}

export function Editor({
  value,
  onChange,
  onSubmit,
  rows = 6,
  spellCheck = false,
  language = "sem",
}: EditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => highlightCode(value + "\n", language), [language, value]);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (!highlightRef.current) return;
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }

  return (
    <div className="editorShell">
      <pre
        ref={highlightRef}
        className="editor editor__highlight"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
      <textarea
        className="editor editor__input"
        value={value}
        rows={rows}
        spellCheck={spellCheck}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={(e) => {
          if (onSubmit && isRunShortcut(e)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
