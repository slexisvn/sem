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
- non-additive transforms — e.g. a rolling window or `share` over an average or a ratio

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

### Navigation & IntelliSense

- **Hover** a metric, measure, dimension, or model to see its definition.
- **Go to Definition** (`F12`) jumps to where a symbol is declared.
- **Completion** suggests metric / dimension / measure / model names from the current model.
- **Outline** lists every model and its members.

### Metric documentation

**Sem: Generate Metric Docs** renders the model's full metric catalog — tables, joins, dimensions,
measures, and metric formulas — as a Markdown document.

### Syntax highlighting

Keywords, aggregates, the `distinct` modifier, metric transforms (`.mom`, `.rolling(30d)`, `.share`),
join cardinalities, string literals, durations, and comments.

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

  dimension region: string        # shorthand for `= region`
  dimension ordered_at: time      # a time dimension for grains like ordered_at.month

  measure gross       = sum(amount)              # primitive aggregate
  measure order_count = count(id)
  measure buyers      = count(distinct customer_id)

  metric revenue = gross where status = 'paid'   # simple metric: measure + filter
  metric orders  = order_count                   # simple metric
  metric aov     = revenue / orders              # ratio metric → NULLIF
}

policy analyst_vn on Orders restrict region = 'VN'
assert revenue where ordered_at.month = '2026-01' == 1250000
```

Queries read like English: `show <metrics> [by <dims>] [where …] [having …] [order by … desc] [top n]`.

## Requirements

- VS Code **1.75** or newer.

## License

MIT
