import { useRef, useState, type DragEvent } from "react";
import { CSV, LABELS } from "../config/constants.js";

interface FileDropProps {
  onFiles: (files: File[]) => void;
}

export function FileDrop({ onFiles }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const emit = (list: FileList | null) => {
    if (list && list.length > 0) onFiles(Array.from(list));
  };

  const stop = (e: DragEvent, next: boolean) => {
    e.preventDefault();
    setOver(next);
  };

  return (
    <div
      className={`drop${over ? " drop--over" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => stop(e, true)}
      onDragOver={(e) => stop(e, true)}
      onDragLeave={(e) => stop(e, false)}
      onDrop={(e) => {
        stop(e, false);
        emit(e.dataTransfer.files);
      }}
    >
      <span>{LABELS.drop}</span>
      <input
        ref={inputRef}
        type="file"
        accept={CSV.extensions.join(",")}
        multiple
        hidden
        onChange={(e) => {
          emit(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
