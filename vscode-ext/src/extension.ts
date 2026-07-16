import * as vscode from "vscode";
import { loadSem, SemApi, SemPos, SemSymbol, SemSymbolKind, SymbolService } from "./sem-api.js";

const LANGUAGE_ID = "sem";

let sem: SemApi | undefined;
const services = new Map<string, SymbolService>();

const keywordCompletions: readonly KeywordCompletion[] = [
  { label: "model", detail: "Declare a model", contexts: ["topLevel"], snippet: "model ${1:Name} {\n  table ${2:schema.table}\n  primary_key ${3:id}\n\n  $0\n}",
    doc: "A table plus everything sem knows about it: how it joins, what you can group by, and the metrics built on it.\n\n```sem\nmodel Orders {\n  table public.orders\n  primary_key id\n}\n```" },
  { label: "policy", detail: "Declare a policy", contexts: ["topLevel"], snippet: "policy ${1:name} on ${2:Model} restrict ${3:field} = ${4:value}",
    doc: "A mandatory row filter folded into every query touching the model — row-level security or tenant scoping.\n\n```sem\npolicy analyst_vn on Orders restrict region = 'VN'\n```\nApplied by default; pass `policies: []` to compile without them." },
  { label: "assert", detail: "Declare an assertion", contexts: ["topLevel"], snippet: "assert ${1:metric} where ${2:field} = ${3:value} == ${4:expected}",
    doc: "A expectation about a metric's value, compiled to a check you can run in CI.\n\n```sem\nassert revenue where ordered_at.month = '2026-01' == 1250000\nassert aov where region = 'VN' between 20 and 60\n```" },
  { label: "materialize", detail: "Materialize a query", contexts: ["topLevel"], snippet: "materialize ${1:name} as\n  show ${2:metric} by ${3:dimension}",
    doc: "Emits `CREATE MATERIALIZED VIEW <name> AS <query>` for a saved query.\n\n```sem\nmaterialize monthly_revenue as\n  show revenue, revenue.mom by ordered_at.month\n```\nNote: queries are not yet routed to materialized views automatically." },
  { label: "show", detail: "Start a query", contexts: ["topLevel", "query"], snippet: "show ${1:metric} by ${2:dimension}",
    doc: "The query form: pick metrics, group them, filter, sort.\n\n```sem\nshow revenue, aov by region where region = 'VN' order by revenue desc top 5\n```\nMetrics are named — `show` takes no inline arithmetic. Queries live outside `.sem` model files; run one with **Sem: Compile Query to SQL**." },
  { label: "funnel", detail: "Count entities through ordered steps", contexts: ["topLevel", "query"], snippet: "funnel ${1:Model} by ${2:entity_id} over ${3:occurred_at}\n  steps ${4:first} = ${5:field} = ${6:value}, ${7:second} = ${8:field} = ${9:value}",
    doc: "Counts entities that moved through an ordered sequence of steps. Needs two or more named steps; each must occur no earlier than the one before it.\n\n```sem\nfunnel Events by user_id over occurred_at\n  steps viewed = name = 'view', purchased = name = 'purchase'\n```\nOrdering uses each step's **first** occurrence, so it is a first-touch approximation. Runs on every dialect." },
  { label: "retention", detail: "Cohort-by-period retention matrix", contexts: ["topLevel", "query"], snippet: "retention ${1:Model} by ${2:entity_id} over ${3:occurred_at}.${4|day,week,month,quarter,year|} periods ${5:6}",
    doc: "Buckets entities by the first period they appear in, then counts how many are active each later period.\n\n```sem\nretention Events by user_id over signed_up_at.month periods 6\n```\nReturns one row per cohort with `period_0` … `period_N` columns; `period_0` is the cohort size. The time reference must carry a grain." },
  { label: "steps", detail: "Funnel step list", contexts: ["query"],
    doc: "The named steps of a `funnel`, in order. Each step is `<name> = <filter>`, and a step can reuse a `segment`.\n\n```sem\nsteps viewed = name = 'view', carted = name = 'add_to_cart'\n```" },
  { label: "over", detail: "Funnel / retention time column", contexts: ["query"],
    doc: "The time column that orders a `funnel`, or the cohort grain of a `retention`.\n\n```sem\nfunnel Events by user_id over occurred_at ...\nretention Events by user_id over occurred_at.week periods 8\n```" },
  { label: "periods", detail: "Retention horizon", contexts: ["query"],
    doc: "How many periods after the cohort start a `retention` tracks. `periods 6` yields columns `period_0` … `period_6`." },
  { label: "table", detail: "Set model table", contexts: ["modelBody"], snippet: "table ${1:schema.table}",
    doc: "The physical table behind the model — bare or schema-qualified.\n\n```sem\ntable public.orders\n```" },
  { label: "primary_key", detail: "Set model primary key", contexts: ["modelBody"], snippet: "primary_key ${1:id}",
    doc: "The column that identifies one fact row. sem deduplicates on it before aggregating across a fan-out join, so `show revenue by Items.sku` will not double-count.\n\n```sem\nprimary_key id\n```" },
  { label: "join", detail: "Declare a join", contexts: ["modelBody"], snippet: "join ${1:Model} on ${2:local_id} = ${1:Model}.${3:id} (${4|many_to_one,one_to_many,one_to_one,many_to_many|})",
    doc: "Connects two models. The cardinality is what tells sem whether a query fans out and needs dedup.\n\n```sem\njoin Customers on customer_id = Customers.id (many_to_one)\njoin Items     on id = Items.order_id       (one_to_many)\n```" },
  { label: "asof", detail: "Match the row in effect at the fact's timestamp", contexts: ["modelBody"], snippet: "asof ${1:fact_ts} ${2|>=,<=|} ${3:Model}.${4:as_of}",
    doc: "Turns a join into a temporal (as-of) lookup: each fact row matches the slowly-changing row in effect at its timestamp — an exchange rate, a price, a plan tier.\n\n```sem\njoin Rates on currency = Rates.currency asof ordered_at >= Rates.as_of (many_to_one)\n```\n`>=` takes the latest row at or before the fact, `<=` the earliest at or after. The fact timestamp goes on the **left**. Compiles to a lateral `ORDER BY … LIMIT 1`, so there is exactly one match and no fan-out. One-directional. Not available on BigQuery." },
  { label: "dimension", detail: "Declare a dimension", contexts: ["modelBody"], snippet: "dimension ${1:name}: ${2|string,number,boolean,time|} = ${3:column}",
    doc: "A column you group and filter by. The `= <column>` part is optional when it matches the name.\n\n```sem\ndimension region: string\ndimension ordered_at: time\n```\nA `time` dimension can be bucketed in a query: `ordered_at.month`." },
  { label: "measure", detail: "Declare a measure (aggregate primitive over this model's columns)", contexts: ["modelBody"], snippet: "measure ${1:name} = ${2|sum,count,avg,min,max,median|}(${3:column})",
    doc: "A single raw aggregate over this model's own columns — the primitive metrics are built from.\n\n```sem\nmeasure gross : money = sum(amount)\nmeasure buyers = count(distinct customer_id)\n```\nOptionally annotate a **unit** (`: money`) and an **additivity** override (`semi_additive(...)`, `non_additive`)." },
  { label: "metric", detail: "Declare a metric (built from measures: simple, ratio, or derived)", contexts: ["modelBody"], snippet: "metric ${1:name} = ${2:measure}",
    doc: "What consumers actually query. Built from measures or other metrics — never by calling an aggregate directly.\n\n```sem\nmetric revenue     = gross where paid   # filtered\nmetric net_revenue = revenue - refunds  # derived\nmetric aov         = revenue / orders   # ratio, wrapped in NULLIF\n```" },
  { label: "segment", detail: "Declare a reusable named filter", contexts: ["modelBody"], snippet: "segment ${1:name} = ${2:field} = ${3:value}",
    doc: "A named, reusable filter. Usable in a metric's `where`, a query's `where`, a policy, and a funnel step — and segments compose with each other.\n\n```sem\nsegment paid     = status = 'paid'\nsegment domestic = region = 'VN'\nsegment vn_paid  = paid and domestic\n```" },
  { label: "semi_additive", detail: "Additivity: take one snapshot per period, then sum", contexts: ["modelBody"], snippet: "semi_additive(${1|last,first|} by ${2:snapshot_at})",
    doc: "For measures that sum across entities but **not** across time — a balance, an inventory level. Within each period sem takes one snapshot, then sums those.\n\n```sem\nmeasure balance : money semi_additive(last by snapshot_at) = sum(amount)\n```\nOnly valid on a sum-additive aggregate." },
  { label: "non_additive", detail: "Additivity: never re-aggregate this measure", contexts: ["modelBody"],
    doc: "Declares that a measure must never be rolled up over a window. sem then blocks `.rolling`, `.cumulative`, `.share` and `.of` on anything built from it.\n\n```sem\nmeasure score : number non_additive = sum(points)\n```" },
  { label: "string", detail: "Dimension type", contexts: ["type"], doc: "Dimension type: text. Compares with `=`, `in`, `like`." },
  { label: "number", detail: "Dimension type", contexts: ["type"], doc: "Dimension type: numeric. Compares with `=`, `<`, `>`, `between`." },
  { label: "boolean", detail: "Dimension type", contexts: ["type"], doc: "Dimension type: true/false." },
  { label: "time", detail: "Dimension type", contexts: ["type"], doc: "Dimension type: a timestamp or date. Only a `time` dimension can take a grain — `ordered_at.day`, `.week`, `.month`, `.quarter`, `.year` — which compiles to `DATE_TRUNC`." },
  { label: "many_to_one", detail: "Join cardinality", contexts: ["joinCardinality"], doc: "Many fact rows point at one target row — the usual lookup. **No fan-out**, so no dedup is needed." },
  { label: "one_to_many", detail: "Join cardinality", contexts: ["joinCardinality"], doc: "One fact row matches many target rows — e.g. an order and its items. **Fans out**: sem deduplicates on `primary_key` before aggregating so values aren't double-counted." },
  { label: "one_to_one", detail: "Join cardinality", contexts: ["joinCardinality"], doc: "At most one row on each side. **No fan-out**." },
  { label: "many_to_many", detail: "Join cardinality", contexts: ["joinCardinality"], doc: "Many rows on both sides. **Fans out**: sem deduplicates on `primary_key` before aggregating." },
  { label: "by", detail: "Group query results", contexts: ["query"],
    doc: "The dimensions to group by. Qualify a joined one (`Customers.tier`) and add a grain to a time one (`ordered_at.month`).\n\n```sem\nshow revenue by region, ordered_at.month\n```" },
  { label: "where", detail: "Filter expression", contexts: ["query", "expression"], snippet: "where ${1:field} = ${2:value}",
    doc: "Filters rows before aggregation. Accepts `= != < <= > >=`, `and` / `or` / `not`, `in`, `between`, `like` — and segment names.\n\n```sem\nshow revenue by region where status = 'paid' and region in ('VN', 'SG')\n```\nLiterals become bind parameters; they are never interpolated." },
  { label: "having", detail: "Filter aggregate results", contexts: ["query"],
    doc: "Filters on a metric's value, after aggregation.\n\n```sem\nshow revenue by region having revenue > 1000\n```\nNot supported together with a fan-out dimension." },
  { label: "order", detail: "Sort query results", contexts: ["query"], snippet: "order by ${1:metric} ${2|asc,desc|}",
    doc: "Sorts by a metric you are showing.\n\n```sem\nshow revenue by region order by revenue desc\n```" },
  { label: "asc", detail: "Sort ascending (default)", contexts: ["query"], doc: "Sort ascending. This is the default when a direction is omitted." },
  { label: "desc", detail: "Sort descending", contexts: ["query"], doc: "Sort descending." },
  { label: "top", detail: "Limit query results", contexts: ["query"], snippet: "top ${1:10}",
    doc: "Keeps the first *n* rows — compiles to the dialect's `LIMIT`.\n\n```sem\nshow revenue by region order by revenue desc top 5\n```" },
  { label: "on", detail: "Join or policy target", contexts: ["modelBody", "topLevel"], doc: "Introduces a join condition (`join Customers on customer_id = Customers.id`) or a policy's target model (`policy p on Orders`)." },
  { label: "restrict", detail: "Policy restriction", contexts: ["topLevel"], doc: "The filter a `policy` forces onto every query touching its model.\n\n```sem\npolicy analyst_vn on Orders restrict region = 'VN'\n```" },
  { label: "as", detail: "Alias or materialization body", contexts: ["topLevel", "query"], doc: "Introduces a `materialize` body.\n\n```sem\nmaterialize monthly_revenue as\n  show revenue by ordered_at.month\n```" },
  { label: "and", detail: "Boolean conjunction", contexts: ["expression", "query"], doc: "Both sides must hold." },
  { label: "or", detail: "Boolean disjunction", contexts: ["expression", "query"], doc: "Either side may hold." },
  { label: "not", detail: "Boolean negation", contexts: ["expression", "query"], doc: "Negates a condition. sem wraps it in `COALESCE(..., FALSE)` so rows with a NULL dimension are kept rather than silently dropped." },
  { label: "in", detail: "Membership operator", contexts: ["expression", "query"], doc: "Membership test.\n\n```sem\nwhere status in ('paid', 'refunded')\n```" },
  { label: "between", detail: "Range operator", contexts: ["expression", "query"], doc: "Inclusive range test.\n\n```sem\nwhere ordered_at.month between '2026-01' and '2026-03'\n```" },
  { label: "like", detail: "Pattern operator", contexts: ["expression", "query"], doc: "SQL pattern match.\n\n```sem\nwhere region like 'V%'\n```" },
  { label: "true", detail: "Boolean literal", contexts: ["expression", "query"], doc: "Boolean literal." },
  { label: "false", detail: "Boolean literal", contexts: ["expression", "query"], doc: "Boolean literal." },
  { label: "sum", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "sum(${1:column})",
    doc: "Adds values up. **Additive** — safe under every window transform.\n\n```sem\nmeasure gross = sum(amount)\nmeasure weighted = sum(amount * qty)\n```" },
  { label: "count", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "count(${1:column})",
    doc: "Counts rows. **Additive** — re-aggregates with `SUM` over a window.\n\n```sem\nmeasure order_count = count(id)\n```" },
  { label: "count distinct", detail: "Distinct count (fan-out safe)", contexts: ["expression", "query"], snippet: "count(distinct ${1:column})",
    doc: "Counts unique values. **Not additive** — two periods' distinct counts can't be added — so sem blocks `.rolling`, `.cumulative` and `.share` on it.\n\n```sem\nmeasure buyers = count(distinct customer_id)\n```" },
  { label: "avg", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "avg(${1:column})",
    doc: "Mean. **Not additive** — averaging averages is wrong — so window transforms that re-aggregate it are rejected. Prefer a ratio metric (`sum(x) / count(y)`), which sem computes correctly per grain." },
  { label: "min", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "min(${1:column})", doc: "Smallest value. **Additive** under `MIN` — a rolling window re-aggregates with `MIN`." },
  { label: "max", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "max(${1:column})", doc: "Largest value. **Additive** under `MAX` — a rolling window re-aggregates with `MAX`." },
  { label: "median", detail: "Quantile aggregate (non-additive)", contexts: ["expression", "query"], snippet: "median(${1:column})",
    doc: "Exact median. **Not additive**.\n\n```sem\nmeasure p50 : time = median(latency_ms)\n```\nNeeds an exact ordered-set aggregate: Postgres only. Elsewhere use `approx_median`." },
  { label: "percentile", detail: "Quantile aggregate at p (non-additive)", contexts: ["expression", "query"], snippet: "percentile(${1:column}, ${2:95})",
    doc: "Exact percentile at *p*, where *p* is a number in (0, 100]. **Not additive**.\n\n```sem\nmeasure p95 : time = percentile(latency_ms, 95)\n```\nsem will not silently substitute an estimator: on an engine without an exact ordered-set aggregate the query is rejected. Use `approx_percentile` to opt into an estimate." },
  { label: "approx_median", detail: "Approximate median — opts in to an estimate where exact is unavailable", contexts: ["expression", "query"], snippet: "approx_median(${1:column})",
    doc: "Median, computed with the engine's estimator where an exact one isn't available. **Not additive**.\n\nThe name is the point: it stays in the metric definition, so whoever reads the number later knows it's an estimate. On an engine that has the exact function (Postgres), this is answered **exactly**." },
  { label: "approx_percentile", detail: "Approximate percentile — opts in to an estimate where exact is unavailable", contexts: ["expression", "query"], snippet: "approx_percentile(${1:column}, ${2:95})",
    doc: "Percentile at *p*, computed with the engine's estimator where an exact one isn't available. **Not additive**.\n\n```sem\nmeasure p95_est : time = approx_percentile(latency_ms, 95)\n```\nOn BigQuery this uses `APPROX_QUANTILES`; on Postgres it is answered **exactly**. Writing `approx_` is how you say an estimate is acceptable." },
  { label: "distinct", detail: "Deduplicate an aggregate's argument", contexts: ["expression"],
    doc: "Deduplicates an aggregate's argument. Accepted by `count`, `sum` and `avg`; rejected by `min` and `max`.\n\n```sem\nmeasure buyers = count(distinct customer_id)\n```" },
  { label: "last", detail: "Semi-additive rule: latest row in the period", contexts: ["modelBody"], doc: "`semi_additive(last by <dim>)` — within each period take the **latest** row, then sum those across entities. The closing-balance rule." },
  { label: "first", detail: "Semi-additive rule: earliest row in the period", contexts: ["modelBody"], doc: "`semi_additive(first by <dim>)` — within each period take the **earliest** row, then sum those across entities. The opening-balance rule." }
];

const transformDocs: ReadonlyMap<string, string> = new Map([
  ["mom", "**Month-over-month change** — this period's value against the previous one, as a fraction.\n\n```sem\nshow revenue, revenue.mom by ordered_at.month\n```\nNeeds a time grain in `by`. Stays valid on a non-additive base, because it compares period values rather than re-aggregating them."],
  ["yoy", "**Year-over-year change** — against the same period last year, as a fraction. The lag is derived from the grain (12 for months, 4 for quarters).\n\n```sem\nshow revenue.yoy by ordered_at.month, region\n```\nNeeds a time grain in `by`."],
  ["rolling", "**Rolling window** over a duration — `d` (day), `w` (week), `m` (month), `q` (quarter), `y` (year).\n\n```sem\nshow revenue.rolling(30d) by ordered_at.day\n```\nThe duration is converted to a row count at the query's grain. Re-aggregates the base, so the base must be **additive**."],
  ["cumulative", "**Running total** from the start of the series.\n\n```sem\nshow revenue.cumulative by ordered_at.month\n```\nRe-aggregates the base with its own combinator (`SUM` for a sum, `MAX` for a max), so the base must be **additive**."],
  ["share", "**Fraction of the total.** With no argument it's a share of the grand total; with dimensions it's a share within that partition.\n\n```sem\nshow revenue.share by region             # of the grand total\nshow revenue.share(region) by region, status  # within each region\n```\nRequires a **sum-additive** base."],
  ["of", "**Level of detail** — the base re-aggregated to a coarser grain, broadcast onto every row as its own column. `of()` with no argument is the grand total.\n\n```sem\nshow revenue, revenue.of(region) by region, status\n```\nThe subtotal follows the base's own additivity (a `max` measure gives a `MAX` subtotal). Its dimensions must be in `by`, and the base must be **additive**."],
  ["mtd", "**Month-to-date** — a running total that resets at each month boundary.\n\n```sem\nshow revenue.mtd by ordered_at.day\n```\nNeeds a grain in `by` finer than a month, and an **additive** base."],
  ["qtd", "**Quarter-to-date** — a running total that resets at each quarter boundary.\n\n```sem\nshow revenue.qtd by ordered_at.month\n```\nNeeds a grain in `by` finer than a quarter, and an **additive** base."],
  ["ytd", "**Year-to-date** — a running total that resets at each year boundary.\n\n```sem\nshow revenue.ytd by ordered_at.month\n```\nNeeds a grain in `by` finer than a year, and an **additive** base."]
]);

type CompletionContext = "topLevel" | "modelBody" | "type" | "joinCardinality" | "expression" | "query";

interface KeywordCompletion {
  readonly label: string;
  readonly detail: string;
  readonly doc?: string;
  readonly contexts: readonly CompletionContext[];
  readonly snippet?: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  sem = await loadSem();

  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(diagnostics);

  const selector: vscode.DocumentSelector = { language: LANGUAGE_ID };

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new SemHoverProvider()),
    vscode.languages.registerCompletionItemProvider(selector, new SemCompletionProvider(), "."),
    vscode.languages.registerDefinitionProvider(selector, new SemDefinitionProvider()),
    vscode.languages.registerDocumentSymbolProvider(selector, new SemDocumentSymbolProvider()),
    vscode.commands.registerCommand("sem.generateDocs", generateDocsCommand),
    vscode.commands.registerCommand("sem.compileQuery", compileQueryCommand)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document, diagnostics)),
    vscode.workspace.onDidOpenTextDocument((document) => refresh(document, diagnostics)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      services.delete(document.uri.toString());
    })
  );

  for (const document of vscode.workspace.textDocuments) refresh(document, diagnostics);
}

export function deactivate(): void {
  services.clear();
}

function refresh(document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection): void {
  if (document.languageId !== LANGUAGE_ID || sem === undefined) return;
  const key = document.uri.toString();
  try {
    const catalog = sem.catalogFromSource(document.getText());
    services.set(key, new sem.SymbolService(catalog));
    diagnostics.delete(document.uri);
  } catch (error) {
    diagnostics.set(document.uri, [toDiagnostic(document, error)]);
  }
}

function toDiagnostic(document: vscode.TextDocument, error: unknown): vscode.Diagnostic {
  if (sem !== undefined && error instanceof sem.SemError && error.span !== undefined) {
    const start = new vscode.Position(error.span.start.line - 1, error.span.start.column - 1);
    const end = new vscode.Position(error.span.end.line - 1, error.span.end.column - 1);
    const range = start.isEqual(end) ? document.getWordRangeAtPosition(start) ?? new vscode.Range(start, end) : new vscode.Range(start, end);
    const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = LANGUAGE_ID;
    diagnostic.code = error.code;
    return diagnostic;
  }
  const message = error instanceof Error ? error.message : String(error);
  const range = new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length));
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = LANGUAGE_ID;
  return diagnostic;
}

function serviceFor(document: vscode.TextDocument): SymbolService | undefined {
  return services.get(document.uri.toString());
}

function symbolAt(document: vscode.TextDocument, position: vscode.Position): SemSymbol | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/);
  if (range === undefined) return undefined;
  const name = document.getText(range);
  const resolved = serviceFor(document)?.definitionOf(name);
  if (resolved !== undefined) return resolved;
  return fallbackSymbols(document).find((symbol) => symbol.name === name || symbol.qualifiedName === name);
}

function spanToRange(span: SemSymbol["span"]): vscode.Range {
  return new vscode.Range(
    new vscode.Position(span.start.line - 1, span.start.column - 1),
    new vscode.Position(span.end.line - 1, span.end.column - 1)
  );
}

const UNIT_POSITION = /\bmeasure\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*[*/]\s*)*$/;

function unitHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (range === undefined) return undefined;
  const before = document.lineAt(range.start.line).text.slice(0, range.start.character);
  if (!UNIT_POSITION.test(stripStringsAndComments(before))) return undefined;
  const body = [
    `The measure's unit, used for dimensional analysis.`,
    "",
    "Adding or subtracting metrics whose units differ is rejected; `*` and `/` derive new units, and matching ones cancel:",
    "",
    "```sem\nmeasure gross  : money = sum(amount)\nmeasure orders : count = count(id)\nmetric  aov    = gross / orders   # money/count\n```",
    "",
    "Units are opt-in — a measure declared without one unifies with any unit."
  ].join("\n");
  return builtinHover(document.getText(range), "unit", body, range);
}

class SemHoverProvider implements vscode.HoverProvider {
  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const unit = unitHover(document, position);
    if (unit !== undefined) return unit;

    const symbol = symbolAt(document, position);
    if (symbol !== undefined) {
      const markdown = new vscode.MarkdownString(symbol.documentation ?? "");
      if (symbol.documentation === undefined) markdown.appendCodeblock(symbol.detail, LANGUAGE_ID);
      return new vscode.Hover(markdown);
    }
    return languageHover(document, position);
  }
}

function languageHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (range === undefined) return undefined;
  const word = document.getText(range);

  const afterDot = range.start.character > 0 && document.lineAt(range.start.line).text[range.start.character - 1] === ".";
  const transform = afterDot ? transformDocs.get(word) : undefined;
  if (transform !== undefined) return builtinHover(`.${word}`, "transform", transform, range);

  const keyword = keywordCompletions.find((entry) => entry.label === word);
  if (keyword !== undefined) return builtinHover(word, keywordLabel(word), keyword.doc ?? keyword.detail, range);

  return undefined;
}

function keywordLabel(word: string): string {
  switch (keywordKind(word)) {
    case vscode.CompletionItemKind.Function:
      return "aggregate";
    case vscode.CompletionItemKind.TypeParameter:
      return "type";
    case vscode.CompletionItemKind.Constant:
      return "constant";
    default:
      return "keyword";
  }
}

function builtinHover(label: string, kind: string, body: string, range: vscode.Range): vscode.Hover {
  const markdown = new vscode.MarkdownString(`**${kind}** \`${label}\`\n\n${body}`);
  return new vscode.Hover(markdown, range);
}

class SemCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    const context = completionContext(document, position);
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const keyword of keywordCompletions) {
      if (keyword.contexts.includes(context)) addCompletion(items, seen, keywordItem(keyword), `keyword:${keyword.label}`);
    }

    if (shouldSuggestSymbols(context)) {
      const service = serviceFor(document);
      if (service !== undefined) {
        for (const symbol of service.symbols()) addCompletion(items, seen, symbolItem(symbol), `symbol:${symbol.qualifiedName}`);
      }

      for (const symbol of fallbackSymbols(document)) addCompletion(items, seen, symbolItem(symbol), `symbol:${symbol.qualifiedName}`);
    }

    return items;
  }
}

function addCompletion(items: vscode.CompletionItem[], seen: Set<string>, item: vscode.CompletionItem, key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

function keywordItem(keyword: KeywordCompletion): vscode.CompletionItem {
  const item = new vscode.CompletionItem(keyword.label, keywordKind(keyword.label));
  item.detail = keyword.detail;
  if (keyword.doc !== undefined) item.documentation = new vscode.MarkdownString(keyword.doc);
  item.sortText = `0_${keyword.label}`;
  if (keyword.snippet !== undefined) item.insertText = new vscode.SnippetString(keyword.snippet);
  return item;
}

function symbolItem(symbol: SemSymbol): vscode.CompletionItem {
  const item = new vscode.CompletionItem({ label: symbol.name, description: symbol.model }, completionKind(symbol.kind));
  item.insertText = symbol.name;
  item.detail = symbol.detail;
  item.sortText = `1_${symbol.kind}_${symbol.qualifiedName}`;
  if (symbol.qualifiedName !== symbol.name) item.filterText = `${symbol.name} ${symbol.qualifiedName}`;
  return item;
}

function shouldSuggestSymbols(context: CompletionContext): boolean {
  return context === "topLevel" || context === "modelBody" || context === "expression" || context === "query";
}

function completionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContext {
  const textBefore = stripStringsAndComments(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
  const lineBefore = stripStringsAndComments(document.lineAt(position.line).text.slice(0, position.character));
  if (/\bdimension\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z_]*$/.test(lineBefore)) return "type";
  if (/\bjoin\b.*\([^)]*$/.test(lineBefore)) return "joinCardinality";
  if (/\b(show|funnel|retention)\b/.test(lineBefore) || /^\s*(show|funnel|retention|steps|over|periods|by|where|having|order|top)\b/.test(lineBefore)) return "query";
  if (isExpressionLine(lineBefore)) return "expression";
  return modelBraceDepth(textBefore) > 0 ? "modelBody" : "topLevel";
}

function isExpressionLine(lineBefore: string): boolean {
  return /^\s*(dimension|measure|metric|segment)\b.*=\s*/.test(lineBefore)
    || /^\s*(assert|policy)\b.*\b(where|restrict)\b/.test(lineBefore)
    || /\b(where|having)\s+/.test(lineBefore);
}

function modelBraceDepth(source: string): number {
  let depth = 0;
  for (const char of source) {
    if (char === "{") depth++;
    if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function stripStringsAndComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      if (char === "'" && next === "'") {
        out += "  ";
        i++;
        continue;
      }
      if (char === "'") inString = false;
      out += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "'") {
      inString = true;
      out += " ";
      continue;
    }
    if (char === "#") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < source.length) out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

function fallbackSymbols(document: vscode.TextDocument): SemSymbol[] {
  const symbols: SemSymbol[] = [];
  const searchable = stripStringsAndComments(document.getText());
  const patterns: ReadonlyArray<readonly [RegExp, SemSymbolKind]> = [
    [/\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)/g, "model"],
    [/\bdimension\s+([A-Za-z_][A-Za-z0-9_]*)/g, "dimension"],
    [/\bmeasure\s+([A-Za-z_][A-Za-z0-9_]*)/g, "measure"],
    [/\bmetric\s+([A-Za-z_][A-Za-z0-9_]*)/g, "metric"],
    [/\bsegment\s+([A-Za-z_][A-Za-z0-9_]*)/g, "segment"]
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const name = match[1]!;
      const offset = match.index! + match[0].indexOf(name);
      symbols.push({
        name,
        qualifiedName: name,
        kind,
        detail: `${kind} ${name}`,
        documentation: `**${kind}** \`${name}\`\n\nDeclared in this file. Full details appear once the file parses cleanly.`,
        span: { start: semPos(document, offset), end: semPos(document, offset + name.length) }
      });
    }
  }
  return symbols;
}

function semPos(document: vscode.TextDocument, offset: number): SemPos {
  const position = document.positionAt(offset);
  return { line: position.line + 1, column: position.character + 1 };
}

function keywordKind(label: string): vscode.CompletionItemKind {
  switch (label) {
    case "sum":
    case "count":
    case "count distinct":
    case "avg":
    case "min":
    case "max":
    case "median":
    case "percentile":
      return vscode.CompletionItemKind.Function;
    case "string":
    case "number":
    case "boolean":
    case "time":
      return vscode.CompletionItemKind.TypeParameter;
    case "true":
    case "false":
    case "many_to_one":
    case "one_to_many":
    case "one_to_one":
    case "many_to_many":
      return vscode.CompletionItemKind.Constant;
    default:
      return vscode.CompletionItemKind.Keyword;
  }
}

class SemDefinitionProvider implements vscode.DefinitionProvider {
  public provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const symbol = symbolAt(document, position);
    if (symbol === undefined) return undefined;
    return new vscode.Location(document.uri, spanToRange(symbol.span));
  }
}

class SemDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  public provideDocumentSymbols(document: vscode.TextDocument): vscode.ProviderResult<vscode.SymbolInformation[]> {
    const service = serviceFor(document);
    if (service === undefined) return undefined;
    return service.symbols().map(
      (symbol) =>
        new vscode.SymbolInformation(
          symbol.qualifiedName,
          symbolKind(symbol.kind),
          symbol.model ?? "",
          new vscode.Location(document.uri, spanToRange(symbol.span))
        )
    );
  }
}

async function generateDocsCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || sem === undefined) return;
  try {
    const catalog = sem.catalogFromSource(editor.document.getText());
    const markdown = sem.generateDocs(catalog);
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Sem: ${message}`);
  }
}

async function compileQueryCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || sem === undefined) return;

  const selection = editor.document.getText(editor.selection).trim();
  const query = selection.length > 0
    ? selection
    : await vscode.window.showInputBox({
        title: "Compile Sem query",
        prompt: "Enter a Sem query to compile against this model",
        placeHolder: "show revenue, aov by region where region = 'VN'",
        value: "show revenue by region"
      });
  if (query === undefined || query.trim().length === 0) return;

  try {
    const catalog = sem.catalogFromSource(editor.document.getText());
    const { sql, params } = sem.compileWithCatalog(catalog, query.trim());
    const header = `-- query: ${query.trim()}\n-- params: ${JSON.stringify(params)}\n\n`;
    const doc = await vscode.workspace.openTextDocument({ language: "sql", content: header + sql });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Sem: ${message}`);
  }
}

function completionKind(kind: SemSymbolKind): vscode.CompletionItemKind {
  switch (kind) {
    case "model":
      return vscode.CompletionItemKind.Class;
    case "metric":
      return vscode.CompletionItemKind.Function;
    case "measure":
      return vscode.CompletionItemKind.Value;
    case "dimension":
      return vscode.CompletionItemKind.Field;
    case "segment":
      return vscode.CompletionItemKind.EnumMember;
  }
}

function symbolKind(kind: SemSymbolKind): vscode.SymbolKind {
  switch (kind) {
    case "model":
      return vscode.SymbolKind.Class;
    case "metric":
      return vscode.SymbolKind.Function;
    case "measure":
      return vscode.SymbolKind.Constant;
    case "dimension":
      return vscode.SymbolKind.Field;
    case "segment":
      return vscode.SymbolKind.EnumMember;
  }
}
