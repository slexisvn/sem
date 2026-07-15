export interface SemPos {
  readonly line: number;
  readonly column: number;
}

export interface SemSpan {
  readonly start: SemPos;
  readonly end: SemPos;
}

export type SemSymbolKind = "model" | "dimension" | "measure" | "metric";

export interface SemSymbol {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SemSymbolKind;
  readonly model?: string;
  readonly detail: string;
  readonly span: SemSpan;
}

export interface SymbolService {
  symbols(): SemSymbol[];
  definitionOf(name: string): SemSymbol | undefined;
  hover(name: string): string | undefined;
  completions(prefix: string): string[];
}

export interface SemCatalog {
  readonly models: ReadonlyMap<string, unknown>;
}

export interface SemErrorLike {
  readonly code: string;
  readonly message: string;
  readonly span?: SemSpan;
}

export interface SemSqlResult {
  readonly sql: string;
  readonly params: (string | number | boolean)[];
}

export interface SemApi {
  catalogFromSource(source: string): SemCatalog;
  compileWithCatalog(catalog: SemCatalog, querySource: string): SemSqlResult;
  generateDocs(catalog: SemCatalog): string;
  SymbolService: new (catalog: SemCatalog) => SymbolService;
  SemError: abstract new (...args: never[]) => SemErrorLike;
}

export async function loadSem(): Promise<SemApi> {
  return (await import("sem")) as unknown as SemApi;
}
