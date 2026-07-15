import { Pos, Span } from "../lexer/token.js";

export enum DiagCode {
  LexError = "lex-error",
  ParseError = "parse-error",
  DuplicateName = "duplicate-name",
  UnknownModel = "unknown-model",
  UnknownMetric = "unknown-metric",
  UnknownDimension = "unknown-dimension",
  UnknownAggregate = "unknown-aggregate",
  UnknownGrain = "unknown-grain",
  AmbiguousReference = "ambiguous-reference",
  CyclicMetric = "cyclic-metric",
  TypeMismatch = "type-mismatch",
  UnreachableJoin = "unreachable-join",
  AmbiguousJoin = "ambiguous-join",
  Unsupported = "unsupported"
}

export class SemError extends Error {
  public readonly code: DiagCode;
  public readonly span?: Span;
  public readonly suggestion?: string;

  constructor(code: DiagCode, message: string, span?: Span, suggestion?: string) {
    super(SemError.format(code, message, span, suggestion));
    this.name = "SemError";
    this.code = code;
    this.span = span;
    this.suggestion = suggestion;
  }

  private static format(code: DiagCode, message: string, span?: Span, suggestion?: string): string {
    const where = span ? ` at ${SemError.posText(span.start)}` : "";
    const hint = suggestion ? ` (did you mean '${suggestion}'?)` : "";
    return `[${code}]${where}: ${message}${hint}`;
  }

  private static posText(pos: Pos): string {
    return `line ${pos.line}:${pos.column}`;
  }
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

export function closestName(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dist = levenshtein(target.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  const limit = Math.max(2, Math.floor(target.length / 2));
  return best !== undefined && bestDist <= limit ? best : undefined;
}
