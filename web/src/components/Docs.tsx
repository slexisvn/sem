import type { ReactNode } from "react";
import { highlightCode, type HighlightLanguage } from "../services/highlight.js";

interface SectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

function Section({ id, title, children }: SectionProps) {
  return (
    <section className="docs__section" id={id}>
      <h2 className="docs__h2">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children, lang = "sem" }: { children: string; lang?: HighlightLanguage | "text" }) {
  if (lang === "text") {
    return (
      <pre className="docs__code">
        <code>{children}</code>
      </pre>
    );
  }
  return (
    <pre className="docs__code">
      <code dangerouslySetInnerHTML={{ __html: highlightCode(children, lang) }} />
    </pre>
  );
}

const TOC: Array<{ id: string; label: string }> = [
  { id: "what", label: "What is sem?" },
  { id: "pipeline", label: "How it compiles" },
  { id: "model", label: "Models" },
  { id: "joins", label: "Joins & fan-out" },
  { id: "dimensions", label: "Dimensions" },
  { id: "measures", label: "Measures" },
  { id: "metrics", label: "Metrics" },
  { id: "query", label: "Queries" },
  { id: "transforms", label: "Time transforms" },
  { id: "policies", label: "Policies" },
  { id: "materialize", label: "Materialize & assert" },
  { id: "dialects", label: "Dialects" },
  { id: "reference", label: "Grammar reference" },
];

export function Docs() {
  return (
    <div className="docs">
      <aside className="docs__toc" aria-label="Table of contents">
        <p className="docs__toc-title">On this page</p>
        <nav>
          {TOC.map((item) => (
            <a key={item.id} href={`#${item.id}`} className="docs__toc-link">
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="docs__body">
        <Section id="what" title="What is sem?">
          <p>
            <strong>sem</strong> is a small semantic-layer DSL that compiles to SQL text. You describe
            your data once — the tables, how they join, and the metrics that matter — and then ask
            business questions in a compact query language. sem turns each question into correct,
            dialect-specific SQL so you never hand-write the same joins, filters, and window functions
            again.
          </p>
          <p>
            A sem program has two parts: a <em>schema</em> (one or more <code>model</code> blocks) and a{" "}
            <em>query</em> (a <code>show … by …</code> statement). The playground on the other tab lets you
            edit both, compile to SQL, and run the result against your own CSV files.
          </p>
          <Code>{`# schema
model Orders {
  table public.orders
  primary_key id

  dimension region: string
  dimension status: string

  measure gross = sum(amount)
  metric  revenue = gross where status = 'paid'
}

# query
show revenue by region`}</Code>
        </Section>

        <Section id="pipeline" title="How it compiles">
          <p>Every compile runs through a fixed pipeline:</p>
          <Code lang="text">{`source text
  → lexer      (tokens)
  → parser     (AST: models + query)
  → catalog    (resolved models, joins, metrics)
  → analyzer   (a query Plan / IR)
  → codegen    (SQL for the chosen dialect)`}</Code>
          <p>
            The <strong>catalog</strong> is the resolved semantic model — it knows every dimension,
            measure, metric, join and policy. The <strong>analyzer</strong> takes a query plus the
            catalog and produces a plan that already accounts for join paths, fan-out dedup, filters,
            and any time-series scaffolding. <strong>codegen</strong> renders that plan for Postgres,
            BigQuery, or MySQL.
          </p>
        </Section>

        <Section id="model" title="Models">
          <p>
            A <code>model</code> maps a physical table to a set of semantic fields. It declares the
            table, its primary key, and any number of joins, dimensions, measures, and metrics.
          </p>
          <Code>{`model Orders {
  table public.orders        # physical table (schema-qualified is fine)
  primary_key id             # used to dedup on fan-out joins

  join Customers on customer_id = Customers.id (many_to_one)

  dimension region: string   # group-by columns
  dimension ordered_at: time

  measure gross = sum(amount)          # raw aggregate
  metric  revenue = gross where status = 'paid'   # business metric
}`}</Code>
          <ul className="docs__list">
            <li>
              <code>table</code> — the source table. It may be schema-qualified (<code>public.orders</code>).
            </li>
            <li>
              <code>primary_key</code> — the row identity. sem uses it to de-duplicate rows before
              aggregating across one-to-many joins.
            </li>
          </ul>
        </Section>

        <Section id="joins" title="Joins & fan-out">
          <p>
            Joins connect models. Each join names the target model, the join condition, and the{" "}
            <em>cardinality</em>.
          </p>
          <Code>{`join Customers on customer_id = Customers.id (many_to_one)
join Items     on id = Items.order_id       (one_to_many)`}</Code>
          <p>Cardinalities: <code>many_to_one</code>, <code>one_to_many</code>, <code>one_to_one</code>, <code>many_to_many</code>.</p>
          <p>
            <strong>Fan-out safety.</strong> When a query aggregates a measure across a{" "}
            <code>one_to_many</code> (or <code>many_to_many</code>) join, naïve SQL would double-count
            rows. sem detects this and deduplicates on the primary key before summing, so{" "}
            <code>show revenue by Items.sku</code> stays correct even though each order has many items.
          </p>
        </Section>

        <Section id="dimensions" title="Dimensions">
          <p>
            Dimensions are the columns you group and filter by. Each has a type:{" "}
            <code>string</code>, <code>number</code>, <code>boolean</code>, or <code>time</code>.
          </p>
          <Code>{`dimension region: string
dimension is_trial: boolean
dimension ordered_at: time`}</Code>
          <p>
            A <code>time</code> dimension can be bucketed to a grain in a query with a member access:{" "}
            <code>ordered_at.day</code>, <code>.week</code>, <code>.month</code>, <code>.quarter</code>,{" "}
            <code>.year</code>. Dimensions on joined models are reached by qualifying them —{" "}
            <code>Customers.tier</code>.
          </p>
        </Section>

        <Section id="measures" title="Measures">
          <p>
            A <code>measure</code> is a raw aggregate over one model. It is the building block metrics
            are made of. Supported aggregate functions: <code>sum</code>, <code>count</code>,{" "}
            <code>avg</code>, <code>min</code>, <code>max</code>, plus <code>count(distinct …)</code>.
          </p>
          <Code>{`measure gross       = sum(amount)
measure order_count = count(id)
measure buyer_count = count(distinct customer_id)
measure amount_max  = max(amount)`}</Code>
          <p className="docs__note">
            Measures are usually not queried directly — you expose them to consumers as metrics.
          </p>
        </Section>

        <Section id="metrics" title="Metrics">
          <p>
            A <code>metric</code> is the business-facing number. It can be a measure, a filtered
            measure, or arithmetic over other metrics.
          </p>
          <Code>{`metric revenue     = gross where status = 'paid'   # filtered measure
metric refunds     = gross where status = 'refunded'
metric net_revenue = revenue - refunds             # metric arithmetic
metric orders      = order_count
metric aov         = revenue / orders              # ratio metric`}</Code>
          <ul className="docs__list">
            <li>
              <strong>Filtered metric</strong> — <code>measure where &lt;condition&gt;</code> applies the
              filter only to that metric's aggregate, so <code>revenue</code> and <code>refunds</code>{" "}
              can live in the same row.
            </li>
            <li>
              <strong>Derived metric</strong> — combine metrics with <code>+ - * /</code>. Ratios like{" "}
              <code>aov = revenue / orders</code> compose from parts and stay correct at any grain.
            </li>
          </ul>
        </Section>

        <Section id="query" title="Queries">
          <p>A query is one statement. Only <code>show</code> and <code>by</code> are required.</p>
          <Code>{`show <metrics> [by <dimensions>]
                 [where <filter>]
                 [having <filter>]
                 [order by <metric> [asc|desc]]
                 [top <n>]`}</Code>
          <Code>{`show revenue, net_revenue, aov by region
show buyers by Customers.tier
show revenue by region where region != 'VN' order by revenue desc top 5
show revenue by ordered_at.month having revenue > 100000`}</Code>
          <ul className="docs__list">
            <li><code>show</code> — comma-separated metrics to select.</li>
            <li><code>by</code> — dimensions to group by (bucket time with <code>.month</code> etc.).</li>
            <li><code>where</code> — filters rows before aggregation.</li>
            <li><code>having</code> — filters groups after aggregation.</li>
            <li><code>order by</code> — sort by a metric, <code>asc</code> (default) or <code>desc</code>.</li>
            <li><code>top n</code> — keep the first <code>n</code> rows.</li>
          </ul>
          <p>
            Filter expressions support <code>= != &lt; &lt;= &gt; &gt;=</code>, <code>and</code> /{" "}
            <code>or</code> / <code>not</code>, and <code>in</code>, <code>between</code>, <code>like</code>.
          </p>
        </Section>

        <Section id="transforms" title="Time transforms">
          <p>
            Metrics carry time-series transforms as a suffix in the query. They add window/period
            logic — and, where needed, a dense date spine — without you writing any window SQL.
          </p>
          <Code>{`show revenue, revenue.mom by ordered_at.month        # month-over-month change
show revenue.yoy by ordered_at.month, region        # year-over-year, per region
show revenue.rolling(90d) by ordered_at.day         # 90-day rolling window
show events.cumulative by occurred_at.day           # running total
show revenue.share by region                        # each group's share of total`}</Code>
          <table className="docs__table">
            <thead>
              <tr><th>Transform</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>.mom</code></td><td>Change vs. the previous period.</td></tr>
              <tr><td><code>.yoy</code></td><td>Change vs. the same period last year.</td></tr>
              <tr><td><code>.rolling(Nd)</code></td><td>Rolling window over a duration (<code>d w m q y</code>).</td></tr>
              <tr><td><code>.cumulative</code></td><td>Running total from the start of the series.</td></tr>
              <tr><td><code>.share</code></td><td>The group's fraction of the overall total.</td></tr>
            </tbody>
          </table>
          <p className="docs__note">
            Duration units for <code>rolling</code>: <code>d</code> (day), <code>w</code> (week),{" "}
            <code>m</code> (month), <code>q</code> (quarter), <code>y</code> (year) — e.g.{" "}
            <code>rolling(7d)</code>, <code>rolling(1y)</code>.
          </p>
        </Section>

        <Section id="policies" title="Policies">
          <p>
            A <code>policy</code> attaches a mandatory row filter to a model — useful for row-level
            security or tenant scoping. The restriction is folded into every query touching that model.
          </p>
          <Code>{`policy analyst_vn on Orders restrict region = 'VN'`}</Code>
        </Section>

        <Section id="materialize" title="Materialize & assert">
          <p>
            <code>materialize</code> gives a saved query a name — a definition for a table/view you
            intend to build. <code>assert</code> states an expectation about a metric, useful as a
            data test.
          </p>
          <Code>{`materialize monthly_revenue as
  show revenue, revenue.mom, revenue.rolling(90d) by ordered_at.month

assert revenue where ordered_at.month = '2026-01' == 1250000
assert aov where region = 'VN' between 20 and 60`}</Code>
        </Section>

        <Section id="dialects" title="Dialects">
          <p>
            codegen targets three SQL dialects: <strong>Postgres</strong> (default),{" "}
            <strong>BigQuery</strong>, and <strong>MySQL</strong>. The same semantic model and query
            compile to each — quoting, date bucketing, and window syntax adapt per dialect.
          </p>
          <Code lang="javascript">{`import { compile, postgres, bigquery, mysql } from "@slexisvn/sem";

const sql = compile(schemaSource, "show revenue by region", {
  dialect: bigquery,
}).sql;`}</Code>
        </Section>

        <Section id="reference" title="Grammar reference">
          <p>The full set of keywords and forms:</p>
          <Code>{`# --- schema ---
model <Name> {
  table <name | schema.name>
  primary_key <column>
  join <Model> on <cond> (<cardinality>)
  dimension <name>: <string|number|boolean|time>
  measure <name> = <agg>(<column>)
  metric  <name> = <measure | metric expr> [where <filter>]
}

policy <name> on <Model> restrict <filter>
materialize <name> as <query>
assert <metric> [where <filter>] <== | between .. and ..> <value>

# --- query ---
show <metric[.transform]> , ...
  [by <dimension[.grain]> , ...]
  [where <filter>]
  [having <filter>]
  [order by <metric> [asc|desc]]
  [top <n>]

# aggregates    sum count avg min max  (+ count(distinct ..))
# cardinalities many_to_one one_to_many one_to_one many_to_many
# grains        day week month quarter year
# transforms    mom yoy rolling(Nd) cumulative share
# operators     = != < <= > >=  and or not  in between like
# comments      lines starting with #`}</Code>
        </Section>
      </article>
    </div>
  );
}
