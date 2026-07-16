# Sem

Language support for **Sem**, a semantic-layer DSL that compiles metric definitions to SQL. Define a
metric once in a `.sem` model and let the editor check it, explain it, and turn queries into SQL —
all powered by the same compiler that generates the SQL, so what you see in the editor is exactly
what runs.

## Features

### Live diagnostics

Every edit is parsed and semantically checked. Errors appear inline, at the exact source position,
with suggestions:

- unknown metric or dimension — *did you mean 'revenue'?*
- cyclic derived metrics (`a = b`, `b = a`)
- type mismatches — a time grain on a string dimension, comparing incompatible types
- unreachable or ambiguous join paths
- duplicate names, unknown aggregates, bad cardinalities
- role violations — a `measure` that isn't a single aggregate over its own columns, or a
  `metric` that calls an aggregate directly instead of building on a measure
- non-additive transforms — e.g. a rolling window, `share`, or `.of` over an average or a ratio
- unit mismatches — adding `money` to a `count` is rejected, with both units named
- semi-additive misuse — a `semi_additive` rule on an aggregate that can't support it
- cyclic segments, and segment names that clash with a dimension

### Compile a query to SQL

Run **Sem: Compile Query to SQL**. Type a query (or select one in the editor) and the extension
compiles it against the models in the current file, opening the generated SQL beside your model —
filtered metrics as `CASE WHEN`, ratios wrapped in `NULLIF`, fan-out-safe aggregation that
deduplicates on the primary key, distinct counts, window transforms densified over a date spine, and
time grains as `DATE_TRUNC`. Bind parameters are listed in a header comment; values are never
interpolated.

```sem
show revenue, aov by region where region = 'VN' order by revenue desc top 5
```

The same command also compiles the two sequence-analytics forms:

```sem
funnel Events by user_id over occurred_at
  steps viewed = name = 'view', purchased = name = 'purchase'

retention Events by user_id over occurred_at.week periods 8
```

### Navigation & IntelliSense

- **Hover** a metric, measure, dimension, segment, or model to see its definition — measures show
  their unit and additivity. Hovering a keyword, aggregate, or transform (`semi_additive`,
  `percentile`, `.of`, `.ytd`, …) explains what it does, what it requires, and shows an example.
- **Go to Definition** (`F12`) jumps to where a symbol is declared.
- **Completion** suggests metric / dimension / measure / segment / model names from the current
  model, plus context-aware keywords and snippets.
- **Outline** lists every model and its members.

### Metric documentation

**Sem: Generate Metric Docs** renders the model's full metric catalog — tables, joins, dimensions,
measures, and metric formulas — as a Markdown document.

### Syntax highlighting

Keywords, aggregates (including `median` / `percentile`), the `distinct` modifier, additivity
modifiers (`semi_additive`, `non_additive`), metric transforms (`.mom`, `.rolling(30d)`, `.share`,
`.of(dims)`, `.mtd` / `.qtd` / `.ytd`), join cardinalities, string literals, durations, and comments.

## Getting started

1. Install the extension.
2. Open or create a `.sem` file
3. Start typing — diagnostics, hover, and completion are active immediately.
4. Open the Command Palette and run **Sem: Compile Query to SQL**.

## Commands

| Command | Description |
| --- | --- |
| `Sem: Compile Query to SQL` | Compile a query (selection or typed) against the open model. |
| `Sem: Generate Metric Docs` | Render the model's metric catalog as Markdown. |

Both commands are available from the Command Palette when a `.sem` file is focused.

## The Sem language, in brief

```sem
model Orders {
  table public.orders
  primary_key id
  join Customers on customer_id = Customers.id (many_to_one)

  # match the rate that was in effect when the order was placed
  join Rates on currency = Rates.currency asof ordered_at >= Rates.as_of (many_to_one)

  dimension region: string        # shorthand for `= region`
  dimension ordered_at: time      # a time dimension for grains like ordered_at.month

  segment paid = status = 'paid'                 # a reusable named filter

  measure gross       : money = sum(amount)      # typed primitive aggregate
  measure order_count : count = count(id)
  measure buyers      = count(distinct customer_id)
  measure p95_amount  = percentile(amount, 95)   # quantile (non-additive)

  metric revenue = gross where paid              # simple metric: measure + segment
  metric orders  = order_count                   # simple metric
  metric aov     = revenue / orders              # ratio metric → NULLIF
}

policy analyst_vn on Orders restrict region = 'VN'
assert revenue where ordered_at.month = '2026-01' == 1250000
```

Units are opt-in: annotate a measure with `: money` and sem rejects nonsense like `money + count`,
while unannotated measures keep working unchanged.

Queries read like English:

- `show <metrics> [by <dims>] [where …] [having …] [order by … desc] [top n]`
- `funnel <Model> by <entity> over <time> steps <name> = <filter>, …`
- `retention <Model> by <entity> over <time>.<grain> periods <n>`

## Requirements

- VS Code **1.75** or newer.

## License

MIT
