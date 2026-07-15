import type { CSSProperties, ReactNode } from "react";

interface PanelProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  grow?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Panel({ title, actions, children, grow, className = "", style }: PanelProps) {
  const classes = ["panel", grow ? "panel--grow" : "", className].filter(Boolean).join(" ");

  return (
    <section className={classes} style={style}>
      <header className="panel__head">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
