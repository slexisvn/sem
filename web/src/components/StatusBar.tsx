import type { Status } from "../domain/types.js";

interface StatusBarProps {
  status: Status;
}

export function StatusBar({ status }: StatusBarProps) {
  if (!status.message) return null;
  return <div className={`status status--${status.kind}`}>{status.message}</div>;
}
