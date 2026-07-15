import CodeMirror from "@uiw/react-codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { SHORTCUTS } from "../config/constants.js";
import { semCompletions, semHighlighting, semLanguage } from "../services/semLanguage.js";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  rows?: number;
  language?: "sem";
}

export function Editor({ value, onChange, onSubmit, rows = 6 }: EditorProps) {
  const minHeight = `${rows * 1.55 + 1.8}em`;

  return (
    <CodeMirror
      value={value}
      height={minHeight}
      minHeight={minHeight}
      basicSetup={{
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: false,
        lineNumbers: false,
      }}
      extensions={[
        lineNumbers(),
        EditorView.lineWrapping,
        semLanguage,
        semHighlighting,
        autocompletion({
          activateOnTyping: true,
          override: [semCompletions],
        }),
        Prec.highest(
          keymap.of([
            {
              key: `${SHORTCUTS.run.withMeta ? "Mod-" : ""}${SHORTCUTS.run.key}`,
              run: () => {
                onSubmit?.();
                return Boolean(onSubmit);
              },
            },
          ])
        ),
      ]}
      onChange={onChange}
      theme="dark"
      className="editor editor--cm"
    />
  );
}
