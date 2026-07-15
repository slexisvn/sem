import * as vscode from "vscode";
import { loadSem, SemApi, SemSymbol, SemSymbolKind, SymbolService } from "./sem-api.js";

const LANGUAGE_ID = "sem";

let sem: SemApi | undefined;
const services = new Map<string, SymbolService>();

const keywordCompletions: readonly KeywordCompletion[] = [
  { label: "model", detail: "Declare a model", contexts: ["topLevel"], snippet: "model ${1:Name} {\n  table ${2:schema.table}\n  primary_key ${3:id}\n\n  $0\n}" },
  { label: "policy", detail: "Declare a policy", contexts: ["topLevel"], snippet: "policy ${1:name} on ${2:Model} restrict ${3:field} = ${4:value}" },
  { label: "assert", detail: "Declare an assertion", contexts: ["topLevel"], snippet: "assert ${1:metric} where ${2:field} = ${3:value} == ${4:expected}" },
  { label: "materialize", detail: "Materialize a query", contexts: ["topLevel"] },
  { label: "show", detail: "Start a query", contexts: ["topLevel", "query"], snippet: "show ${1:metric} by ${2:dimension}" },
  { label: "table", detail: "Set model table", contexts: ["modelBody"], snippet: "table ${1:schema.table}" },
  { label: "primary_key", detail: "Set model primary key", contexts: ["modelBody"], snippet: "primary_key ${1:id}" },
  { label: "join", detail: "Declare a join", contexts: ["modelBody"], snippet: "join ${1:Model} on ${2:local_id} = ${1:Model}.${3:id} (${4|many_to_one,one_to_many,one_to_one,many_to_many|})" },
  { label: "dimension", detail: "Declare a dimension", contexts: ["modelBody"], snippet: "dimension ${1:name}: ${2|string,number,boolean,time|} = ${3:column}" },
  { label: "measure", detail: "Declare a measure (aggregate primitive over this model's columns)", contexts: ["modelBody"], snippet: "measure ${1:name} = ${2|sum,count,avg,min,max|}(${3:column})" },
  { label: "metric", detail: "Declare a metric (built from measures: simple, ratio, or derived)", contexts: ["modelBody"], snippet: "metric ${1:name} = ${2:measure}" },
  { label: "string", detail: "Dimension type", contexts: ["type"] },
  { label: "number", detail: "Dimension type", contexts: ["type"] },
  { label: "boolean", detail: "Dimension type", contexts: ["type"] },
  { label: "time", detail: "Dimension type", contexts: ["type"] },
  { label: "many_to_one", detail: "Join cardinality", contexts: ["joinCardinality"] },
  { label: "one_to_many", detail: "Join cardinality", contexts: ["joinCardinality"] },
  { label: "one_to_one", detail: "Join cardinality", contexts: ["joinCardinality"] },
  { label: "many_to_many", detail: "Join cardinality", contexts: ["joinCardinality"] },
  { label: "by", detail: "Group query results", contexts: ["query"] },
  { label: "where", detail: "Filter expression", contexts: ["query", "expression"], snippet: "where ${1:field} = ${2:value}" },
  { label: "having", detail: "Filter aggregate results", contexts: ["query"] },
  { label: "order", detail: "Sort query results", contexts: ["query"], snippet: "order ${1:field} ${2|asc,desc|}" },
  { label: "top", detail: "Limit query results", contexts: ["query"], snippet: "top ${1:10}" },
  { label: "on", detail: "Join or policy target", contexts: ["modelBody", "topLevel"] },
  { label: "restrict", detail: "Policy restriction", contexts: ["topLevel"] },
  { label: "as", detail: "Alias or materialization body", contexts: ["topLevel", "query"] },
  { label: "and", detail: "Boolean conjunction", contexts: ["expression", "query"] },
  { label: "or", detail: "Boolean disjunction", contexts: ["expression", "query"] },
  { label: "not", detail: "Boolean negation", contexts: ["expression", "query"] },
  { label: "in", detail: "Membership operator", contexts: ["expression", "query"] },
  { label: "between", detail: "Range operator", contexts: ["expression", "query"] },
  { label: "like", detail: "Pattern operator", contexts: ["expression", "query"] },
  { label: "true", detail: "Boolean literal", contexts: ["expression", "query"] },
  { label: "false", detail: "Boolean literal", contexts: ["expression", "query"] },
  { label: "sum", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "sum(${1:column})" },
  { label: "count", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "count(${1:column})" },
  { label: "count distinct", detail: "Distinct count (fan-out safe)", contexts: ["expression", "query"], snippet: "count(distinct ${1:column})" },
  { label: "avg", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "avg(${1:column})" },
  { label: "min", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "min(${1:column})" },
  { label: "max", detail: "Aggregate function", contexts: ["expression", "query"], snippet: "max(${1:column})" },
  { label: "distinct", detail: "Deduplicate an aggregate's argument", contexts: ["expression"] }
];

type CompletionContext = "topLevel" | "modelBody" | "type" | "joinCardinality" | "expression" | "query";

interface KeywordCompletion {
  readonly label: string;
  readonly detail: string;
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
  const service = serviceFor(document);
  if (service === undefined) return undefined;
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/);
  if (range === undefined) return undefined;
  return service.definitionOf(document.getText(range));
}

function spanToRange(span: SemSymbol["span"]): vscode.Range {
  return new vscode.Range(
    new vscode.Position(span.start.line - 1, span.start.column - 1),
    new vscode.Position(span.end.line - 1, span.end.column - 1)
  );
}

class SemHoverProvider implements vscode.HoverProvider {
  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const symbol = symbolAt(document, position);
    if (symbol === undefined) return undefined;
    const markdown = new vscode.MarkdownString(symbol.documentation ?? "");
    if (symbol.documentation === undefined) markdown.appendCodeblock(symbol.detail, LANGUAGE_ID);
    return new vscode.Hover(markdown);
  }
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

      for (const symbol of fallbackSymbols(document.getText())) addCompletion(items, seen, symbolItem(symbol), `symbol:${symbol.qualifiedName}`);
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
  if (/\bshow\b/.test(lineBefore) || /^\s*(show|by|where|having|order|top)\b/.test(lineBefore)) return "query";
  if (isExpressionLine(lineBefore)) return "expression";
  return modelBraceDepth(textBefore) > 0 ? "modelBody" : "topLevel";
}

function isExpressionLine(lineBefore: string): boolean {
  return /^\s*(dimension|measure|metric)\b.*=\s*/.test(lineBefore)
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

function fallbackSymbols(source: string): SemSymbol[] {
  const symbols: SemSymbol[] = [];
  const searchable = stripStringsAndComments(source);
  const patterns: ReadonlyArray<readonly [RegExp, SemSymbolKind]> = [
    [/\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)/g, "model"],
    [/\bdimension\s+([A-Za-z_][A-Za-z0-9_]*)/g, "dimension"],
    [/\bmeasure\s+([A-Za-z_][A-Za-z0-9_]*)/g, "measure"],
    [/\bmetric\s+([A-Za-z_][A-Za-z0-9_]*)/g, "metric"]
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const name = match[1];
      symbols.push({
        name,
        qualifiedName: name,
        kind,
        detail: `${kind} ${name}`,
        span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
      });
    }
  }
  return symbols;
}

function keywordKind(label: string): vscode.CompletionItemKind {
  switch (label) {
    case "sum":
    case "count":
    case "count distinct":
    case "avg":
    case "min":
    case "max":
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
  }
}
