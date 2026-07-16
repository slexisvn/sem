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
  { id: "segments", label: "Segments" },
  { id: "types", label: "Types & additivity" },
  { id: "query", label: "Queries" },
  { id: "transforms", label: "Time transforms" },
  { id: "timezone", label: "Timezones" },
  { id: "fiscal", label: "Fiscal calendars" },
  { id: "funnel", label: "Funnels" },
  { id: "retention", label: "Retention" },
  { id: "policies", label: "Policies" },
  { id: "materialize", label: "Materialize & assert" },
  { id: "routing", label: "Pre-aggregate routing" },
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
          <p>
            <strong>As-of joins.</strong> Add an <code>asof</code> match to line each fact row up with
            the row of a slowly-changing table that was in effect at the fact's timestamp — an exchange
            rate, a price, a plan tier. The fact timestamp goes on the left of the match.
          </p>
          <Code>{`join Rates on currency = Rates.currency asof ordered_at >= Rates.as_of (many_to_one)`}</Code>
          <p>
            <code>&gt;=</code> takes the latest row at or before the fact; <code>&lt;=</code> takes the
            earliest at or after. sem compiles this to a lateral <code>ORDER BY … LIMIT 1</code> lookup,
            so there is exactly one match and no fan-out. An as-of edge is one-directional. Dialects
            without lateral joins report the query as unsupported rather than emitting a wrong result.
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
            <code>avg</code>, <code>min</code>, <code>max</code>, <code>median</code>,{" "}
            <code>percentile(col, p)</code>, their <code>approx_</code> variants, plus{" "}
            <code>count(distinct …)</code>.
          </p>
          <Code>{`measure gross       = sum(amount)
measure order_count = count(id)
measure buyer_count = count(distinct customer_id)
measure amount_max  = max(amount)
measure latency_p95 = percentile(latency, 95)
measure latency_est = approx_percentile(latency, 95)`}</Code>
          <p className="docs__note">
            Measures are usually not queried directly — you expose them to consumers as metrics.
          </p>
          <p>
            <strong>Exact vs. approximate.</strong> Not every engine can compute an exact quantile.
            sem will not quietly swap in an estimator: <code>percentile</code> is refused where it
            can't be answered exactly. Writing <code>approx_percentile</code> is how you say an
            estimate is acceptable — and the name stays in the metric definition, so nobody reading
            the number later has to guess. On an engine that has the exact function, an{" "}
            <code>approx_</code> measure is simply answered exactly.
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

        <Section id="segments" title="Segments">
          <p>
            A <code>segment</code> is a named, reusable filter — declare a condition once and reference
            it by name in metric filters, query <code>where</code> clauses, and policies. Segments can
            build on other segments.
          </p>
          <Code>{`model Orders {
  segment paid          = status = 'paid'
  segment domestic      = region = 'VN'
  segment domestic_paid = paid and domestic     # segments compose

  metric revenue    = gross where paid
  metric vn_revenue = gross where domestic_paid
}`}</Code>
          <Code>{`show orders by region where paid          # a segment in a query filter`}</Code>
          <p className="docs__note">
            A segment is expanded to its underlying condition at compile time, so it behaves exactly
            like writing the filter inline — just defined in one place. Query <code>where</code> clauses
            still only reach dimensions, so a segment used there must filter on dimensions.
          </p>
        </Section>

        <Section id="types" title="Types & additivity">
          <p>
            sem type-checks your metrics so they can't silently return a wrong number. A measure can
            carry a <em>unit</em> and an <em>additivity</em> rule; every derived metric infers its own
            type from those, and the compiler rejects definitions that don't add up.
          </p>

          <p>
            <strong>Units.</strong> Annotate a measure with <code>: &lt;unit&gt;</code>. Units combine
            under arithmetic — a ratio of <code>money</code> over <code>count</code> has unit{" "}
            <code>money/count</code> — and adding mismatched units is a compile error. Unannotated
            measures stay unchecked, so units are opt-in and spread gradually.
          </p>
          <Code>{`measure gross  : money = sum(amount)
measure orders : count = count(id)

metric revenue = gross where paid       # money
metric aov     = gross / orders         # money/count, inferred
metric broken  = gross + orders         # error: cannot add money and count`}</Code>

          <p>
            <strong>Additivity.</strong> By default a measure is additive across every dimension. Mark
            the exceptions:
          </p>
          <ul className="docs__list">
            <li>
              <code>non_additive</code> — never safe to re-aggregate (an average, a distinct count, a
              percentile). sem blocks window transforms like <code>.rolling</code> or <code>.share</code>{" "}
              on it.
            </li>
            <li>
              <code>semi_additive(last by &lt;dim&gt;)</code> — additive across other dimensions but{" "}
              <em>not</em> along <code>&lt;dim&gt;</code>, where it takes the last (or <code>first</code>)
              value. The classic case is a balance or inventory snapshot.
            </li>
          </ul>
          <Code>{`measure balance : money semi_additive(last by snapshot_at) = sum(amount)
metric total_balance = balance

show total_balance by region`}</Code>
          <p className="docs__note">
            For a semi-additive measure, that query compiles to a two-stage SQL plan: it picks each
            region's latest snapshot with a window, then sums across regions — never summing stale
            snapshots.
          </p>
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
show revenue.mtd by ordered_at.day                  # month-to-date running total
show revenue.ytd by ordered_at.month                # year-to-date running total
show revenue.share by region                        # each group's share of total
show revenue.of(region) by region, status           # region subtotal beside each status`}</Code>
          <table className="docs__table">
            <thead>
              <tr><th>Transform</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>.mom</code></td><td>Change vs. the previous period.</td></tr>
              <tr><td><code>.yoy</code></td><td>Change vs. the same period last year.</td></tr>
              <tr><td><code>.rolling(Nd)</code></td><td>Rolling window over a duration (<code>d w m q y</code>).</td></tr>
              <tr><td><code>.cumulative</code></td><td>Running total from the start of the series.</td></tr>
              <tr><td><code>.mtd / .qtd / .ytd</code></td><td>Running total that resets each month / quarter / year. Needs a finer grain in <code>by</code>.</td></tr>
              <tr><td><code>.share</code></td><td>The group's fraction of the overall total.</td></tr>
              <tr><td><code>.of(dims)</code></td><td>The base re-aggregated to a coarser grain (a subtotal), shown as its own column beside the detail; <code>.of()</code> is the grand total.</td></tr>
            </tbody>
          </table>
          <p className="docs__note">
            Duration units for <code>rolling</code>: <code>d</code> (day), <code>w</code> (week),{" "}
            <code>m</code> (month), <code>q</code> (quarter), <code>y</code> (year) — e.g.{" "}
            <code>rolling(7d)</code>, <code>rolling(1y)</code>.
          </p>
        </Section>

        <Section id="timezone" title="Timezones">
          <p>
            A month is not a fact about an instant — it is a fact about an instant <em>and</em> a
            calendar. By default sem buckets time on whatever calendar the database uses, which is
            usually UTC. For a business in Ho Chi Minh City that quietly moves the first seven hours
            of every month into the previous one.
          </p>
          <p>
            A model may name the zone its calendar should follow. It applies to every time grain on
            that model — in <code>by</code>, in <code>where</code>, and in <code>retention</code> —
            so the grouping and the filter can never disagree about where a month starts.
          </p>
          <Code>{`model Orders {
  table public.orders
  primary_key id
  timezone 'Asia/Ho_Chi_Minh'

  dimension ordered_at: time
  measure gross = sum(amount)
  metric  revenue = gross
}`}</Code>
          <Code lang="sql">{`-- show revenue by ordered_at.month
SELECT DATE_TRUNC('month', orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS ordered_at_month,
       SUM(orders.amount) AS revenue
FROM public.orders AS orders
GROUP BY DATE_TRUNC('month', orders.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh');`}</Code>
          <p>
            The time column is assumed to hold an <strong>absolute instant</strong> —{" "}
            <code>timestamptz</code> on Postgres, <code>TIMESTAMP</code> on BigQuery, and a UTC-stored
            column on MySQL. Each dialect converts with its own primitive:
          </p>
          <table className="docs__table">
            <thead>
              <tr><th>Dialect</th><th>How the zone is applied</th></tr>
            </thead>
            <tbody>
              <tr><td>Postgres</td><td><code>ts AT TIME ZONE 'zone'</code>, then <code>DATE_TRUNC</code></td></tr>
              <tr><td>BigQuery</td><td><code>TIMESTAMP_TRUNC(ts, MONTH, 'zone')</code> — its <code>DATE_TRUNC</code> takes no zone</td></tr>
              <tr><td>MySQL</td><td><code>CONVERT_TZ(ts, 'UTC', 'zone')</code> — needs the tz tables loaded</td></tr>
            </tbody>
          </table>
          <p>
            Two fact tables answering one query must agree on the zone for a shared time dimension. If
            they don't, sem refuses the query rather than putting two different calendars in one
            column. A zone must be a real IANA name; anything else is rejected at build time and never
            reaches the SQL.
          </p>
        </Section>

        <Section id="fiscal" title="Fiscal calendars">
          <p>
            Plenty of companies do not close their year in December. Name the month yours opens and
            two more grains appear on the model's time dimensions:{" "}
            <code>.fiscal_quarter</code> and <code>.fiscal_year</code>.
          </p>
          <Code>{`model Orders {
  table public.orders
  primary_key id
  fiscal_year_starts 4        # the year opens in April

  dimension ordered_at: time
  measure gross = sum(amount)
  metric  revenue = gross
}

# show revenue by ordered_at.fiscal_year
# show revenue.cumulative() by ordered_at.fiscal_quarter`}</Code>
          <p>
            A fiscal period is labelled by the date it starts, like every other grain — so a February
            2026 order under an April year lands in the bucket <code>2025-04-01</code>. The calendar
            grains are left exactly where they were: <code>.year</code> is still the calendar year, and
            a fiscal year opening in January shifts nothing at all.
          </p>
          <table className="docs__table">
            <thead>
              <tr><th>Grain</th><th>Bucket for an order on 2026-02-15, year opening in April</th></tr>
            </thead>
            <tbody>
              <tr><td><code>ordered_at.year</code></td><td><code>2026-01-01</code> — the calendar year</td></tr>
              <tr><td><code>ordered_at.fiscal_year</code></td><td><code>2025-04-01</code> — FY2025, which runs Apr 2025 → Mar 2026</td></tr>
              <tr><td><code>ordered_at.quarter</code></td><td><code>2026-01-01</code> — calendar Q1</td></tr>
              <tr><td><code>ordered_at.fiscal_quarter</code></td><td><code>2026-01-01</code> — FY2025 Q4</td></tr>
            </tbody>
          </table>
          <p>
            Fiscal and calendar periods do not always nest inside one another, and sem will not pretend
            they do. A fiscal quarter under an April year can straddle a calendar year, so{" "}
            <code>revenue.ytd()</code> over <code>.fiscal_quarter</code> is refused rather than
            answered with a number that is quietly wrong. The same rule catches an old sharp edge:{" "}
            <code>revenue.mtd()</code> over <code>.week</code> is refused too, because a week can
            straddle two months.
          </p>
          <p>
            Timezones and fiscal years compose — the instant is made local first, then the fiscal year
            is cut on that local calendar.
          </p>
        </Section>

        <Section id="funnel" title="Funnels">
          <p>
            A <code>funnel</code> counts how many entities moved through an ordered sequence of steps.
            Name the event model, the entity key, the time column, and two or more named steps — each
            step is a condition, and it must occur no earlier than the step before it.
          </p>
          <Code>{`funnel Events by user_id over occurred_at
  steps viewed    = event = 'view',
        carted    = event = 'add_to_cart',
        purchased = event = 'purchase'`}</Code>
          <p>
            sem compiles this to a per-entity first-occurrence timestamp for each step, then counts the
            entities whose timestamps are monotonic. Steps can reuse <a href="#segments">segments</a>.
            The output is one row: a count column per step. Because it only uses grouped{" "}
            <code>MIN</code> and conditional <code>SUM</code>, it runs on every dialect.
          </p>
          <p className="docs__note">
            Ordering is based on each step's <em>first</em> occurrence, so the funnel is a first-touch
            approximation rather than a strict per-event sequence.
          </p>
        </Section>

        <Section id="retention" title="Retention">
          <p>
            A <code>retention</code> query groups entities into cohorts by the first period they
            appear in, then counts how many are still active at each later period. Name the event
            model, the entity key, a time column <em>with a grain</em>, and how many periods to track.
          </p>
          <Code>{`retention Events by user_id over signed_up_at.month periods 6`}</Code>
          <p>
            The result is a matrix: one row per cohort period, and a <code>period_0</code> …{" "}
            <code>period_6</code> column counting the distinct entities active that many periods after
            their cohort start. <code>period_0</code> is the cohort size. sem computes the period
            distance for the chosen grain, so a dialect without that primitive reports the query as
            unsupported rather than guessing.
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

        <Section id="routing" title="Pre-aggregate routing">
          <p>
            A <code>materialize</code> declaration is also a promise about what has been precomputed.
            The planner will answer a later query from one of them when — and only when — it can
            recover the same numbers. Nothing else changes: the query you write is the same.
          </p>
          <Code>{`materialize daily_orders as
  show revenue, orders, aov by region, status, ordered_at.day

# reads daily_orders and re-aggregates: SUM(daily_orders.revenue)
show revenue by region

# reads daily_orders and re-truncates the day column up to a month
show revenue by ordered_at.month

# reads public.orders — an average of averages is not an average
show aov by region`}</Code>
          <p>
            The gate is <a href="#types">additivity</a>, which sem already knows from the type system.
            Rolling a measure up from a coarser pre-aggregate re-aggregates it, so it is only sound
            when the measure is additive at that grain. A <code>sum</code> or <code>count</code> rolls
            up with <code>SUM</code>; a <code>min</code>/<code>max</code> with <code>MIN</code>/
            <code>MAX</code>. A ratio like <code>aov</code>, or a semi-additive balance, cannot — so it
            is refused and the query falls back to the fact table. This is the one thing a semantic
            layer can do that a hand-written rollup table cannot: the refusal is automatic.
          </p>
          <p>
            Asking at exactly the pre-aggregate's own grain re-aggregates nothing, so any metric is
            readable there, ratios included.
          </p>
          <table className="docs__table">
            <thead>
              <tr><th>Query wants</th><th>Pre-aggregate has</th><th>Routed?</th></tr>
            </thead>
            <tbody>
              <tr><td>Additive metric, coarser grain</td><td>Finer grain</td><td>✅ re-aggregated</td></tr>
              <tr><td>Any metric, identical grain</td><td>Identical grain</td><td>✅ read back as-is</td></tr>
              <tr><td><code>ordered_at.month</code></td><td><code>ordered_at.day</code></td><td>✅ days nest in months</td></tr>
              <tr><td><code>ordered_at.month</code></td><td><code>ordered_at.week</code></td><td>❌ weeks straddle months</td></tr>
              <tr><td><code>ordered_at.day</code></td><td><code>ordered_at.month</code></td><td>❌ the days are gone</td></tr>
              <tr><td>Ratio / non-additive, coarser grain</td><td>Finer grain</td><td>❌ would be an average of averages</td></tr>
              <tr><td>Semi-additive, coarser grain</td><td>Finer grain</td><td>❌ would sum a balance across time</td></tr>
              <tr><td>Anything coarser</td><td>A grain built across a fan-out join</td><td>❌ rows are repeated per child</td></tr>
              <tr><td>All orders</td><td>Only paid orders (a <code>where</code> or <code>policy</code>)</td><td>❌ the rows are not there</td></tr>
              <tr><td>Paid orders</td><td>Only paid orders</td><td>✅ the filter is already baked in</td></tr>
            </tbody>
          </table>
          <p>
            A pre-aggregate remembers the filters it was built with — both its own <code>where</code>{" "}
            and any <code>policy</code> folded into it. A query may use it only if it is asking for at
            least those same restrictions; whatever it asks for beyond them is applied to the
            pre-aggregate as a residual filter. So a pre-aggregate over a policy-scoped model serves
            queries under that policy, and is invisible to queries that opt out of it.
          </p>
          <p>
            When several pre-aggregates could serve a query, the narrowest one wins. The compile
            result reports which was used, or nothing if the fact table was read directly.
          </p>
          <Code lang="javascript">{`const { sql, routedTo } = compile(schemaSource, "show revenue by region");
// routedTo === "daily_orders"

// opt out and always read the fact tables
compile(schemaSource, "show revenue by region", { route: false });`}</Code>
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
          <p>
            A few features need a primitive the engine may not have. sem never emulates one with a
            different answer — if the target can't express it exactly, the query is rejected with an{" "}
            <code>unsupported</code> error instead.
          </p>
          <table className="docs__table">
            <thead>
              <tr><th>Feature</th><th>Postgres</th><th>BigQuery</th><th>MySQL</th></tr>
            </thead>
            <tbody>
              <tr><td>Models, metrics, filters, joins, fan-out dedup</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Funnels</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Retention</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Dense date spine (gap-correct windows)</td><td>✅</td><td>✅</td><td>— falls back to a positional grid</td></tr>
              <tr><td>As-of joins</td><td>✅</td><td>❌ no lateral join</td><td>✅ 8.0.14+</td></tr>
              <tr><td>Exact quantiles (<code>median</code>, <code>percentile</code>)</td><td>✅</td><td>❌ estimator only</td><td>❌</td></tr>
              <tr><td>Approximate quantiles (<code>approx_median</code>, <code>approx_percentile</code>)</td><td>✅ answered exactly</td><td>✅</td><td>❌</td></tr>
              <tr><td>Model <code>timezone</code></td><td>✅ <code>AT TIME ZONE</code></td><td>✅ <code>DATETIME(ts, zone)</code></td><td>✅ <code>CONVERT_TZ</code>, needs tz tables</td></tr>
              <tr><td>Fiscal grains (<code>fiscal_year_starts</code>)</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Pre-aggregate routing</td><td>✅</td><td>✅</td><td>✅</td></tr>
            </tbody>
          </table>
        </Section>

        <Section id="reference" title="Grammar reference">
          <p>The full set of keywords and forms:</p>
          <Code>{`# --- schema ---
model <Name> {
  table <name | schema.name>
  primary_key <column>
  timezone '<IANA zone>'
  fiscal_year_starts <1-12>
  join <Model> on <cond> [asof <fact_ts> <op> <target_ts>] (<cardinality>)
  dimension <name>: <string|number|boolean|time>
  measure <name> [: <unit>] [<additivity>] = <agg>(<column>)
  metric  <name> = <measure | metric expr> [where <filter>]
  segment <name> = <filter>
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

# --- funnel ---
funnel <Model> by <entity> over <time>
  steps <name> = <filter> , ...

# --- retention ---
retention <Model> by <entity> over <time>.<grain> periods <n>

# aggregates    sum count avg min max median percentile(col,p)  (+ count(distinct ..))
#               approx_median approx_percentile(col,p)
# units         money count time <name>  combined with * and /
# additivity    non_additive | semi_additive(last|first by <dim>)
# cardinalities many_to_one one_to_many one_to_one many_to_many
# grains        day week month quarter year
#               fiscal_quarter fiscal_year  (need fiscal_year_starts on the model)
# transforms    mom yoy rolling(Nd) cumulative mtd qtd ytd share of(dims)
# operators     = != < <= > >=  and or not  in between like
# comments      lines starting with #`}</Code>
        </Section>
      </article>
    </div>
  );
}
