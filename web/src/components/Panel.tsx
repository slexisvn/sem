import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  grow?: boolean;
}

export function Panel({ title, actions, children, grow }: PanelProps) {
  return (
    <section className={`panel${grow ? " panel--grow" : ""}`}>
      <header className="panel__head">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
