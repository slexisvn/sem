import * as vscode from "vscode";
import { loadSem, SemApi, SemSymbol, SemSymbolKind, SymbolService } from "./sem-api.js";

const LANGUAGE_ID = "sem";

let sem: SemApi | undefined;
const services = new Map<string, SymbolService>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  sem = await loadSem();

  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(diagnostics);

  const selector: vscode.DocumentSelector = { language: LANGUAGE_ID };

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new SemHoverProvider()),
    vscode.languages.registerCompletionItemProvider(selector, new SemCompletionProvider()),
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
    services.delete(key);
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
    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(symbol.detail, LANGUAGE_ID);
    return new vscode.Hover(markdown);
  }
}

class SemCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(document: vscode.TextDocument): vscode.ProviderResult<vscode.CompletionItem[]> {
    const service = serviceFor(document);
    if (service === undefined) return undefined;
    const items: vscode.CompletionItem[] = [];
    for (const symbol of service.symbols()) {
      const item = new vscode.CompletionItem(symbol.name, completionKind(symbol.kind));
      item.detail = symbol.detail;
      if (symbol.qualifiedName !== symbol.name) item.filterText = `${symbol.name} ${symbol.qualifiedName}`;
      items.push(item);
    }
    return items;
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
