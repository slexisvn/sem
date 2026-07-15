import { COMMENT_CHAR, KEYWORDS } from "../config/constants.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Pos, Span, Token, TokKind, TokenValue } from "./token.js";

const SINGLE_CHAR_TOKENS: ReadonlyMap<string, TokKind> = new Map([
  ["{", TokKind.LBrace],
  ["}", TokKind.RBrace],
  ["(", TokKind.LParen],
  [")", TokKind.RParen],
  [",", TokKind.Comma],
  [".", TokKind.Dot],
  [":", TokKind.Colon],
  ["+", TokKind.Plus],
  ["-", TokKind.Minus],
  ["*", TokKind.Star],
  ["/", TokKind.Slash]
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

export class Lexer {
  private readonly source: string;
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(source: string) {
    this.source = source;
  }

  public tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.next();
      tokens.push(token);
      if (token.kind === TokKind.Eof) break;
    }
    return tokens;
  }

  private pos(): Pos {
    return { offset: this.offset, line: this.line, column: this.column };
  }

  private peekChar(ahead = 0): string {
    return this.source[this.offset + ahead] ?? "";
  }

  private advance(): string {
    const ch = this.source[this.offset] ?? "";
    this.offset += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.peekChar();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }
      if (ch === COMMENT_CHAR) {
        while (this.peekChar() !== "\n" && this.peekChar() !== "") this.advance();
        continue;
      }
      break;
    }
  }

  private make(kind: TokKind, text: string, start: Pos, value?: TokenValue): Token {
    const span: Span = { start, end: this.pos() };
    return value === undefined ? { kind, text, span } : { kind, text, value, span };
  }

  private next(): Token {
    this.skipTrivia();
    const start = this.pos();
    const ch = this.peekChar();

    if (ch === "") return this.make(TokKind.Eof, "", start);

    if (ch === "'") return this.readString(start);
    if (isDigit(ch)) return this.readNumber(start);
    if (isIdentStart(ch)) return this.readWord(start);

    return this.readOperator(start);
  }

  private readString(start: Pos): Token {
    this.advance();
    let value = "";
    for (;;) {
      const ch = this.peekChar();
      if (ch === "") {
        throw new SemError(DiagCode.LexError, "unterminated string literal", { start, end: this.pos() });
      }
      if (ch === "'") {
        if (this.peekChar(1) === "'") {
          this.advance();
          this.advance();
          value += "'";
          continue;
        }
        this.advance();
        break;
      }
      value += this.advance();
    }
    return this.make(TokKind.String, value, start, value);
  }

  private readNumber(start: Pos): Token {
    let text = "";
    while (isDigit(this.peekChar())) text += this.advance();
    if (this.peekChar() === "." && isDigit(this.peekChar(1))) {
      text += this.advance();
      while (isDigit(this.peekChar())) text += this.advance();
    }
    if (isIdentStart(this.peekChar())) {
      let unit = "";
      while (isIdentPart(this.peekChar())) unit += this.advance();
      return this.make(TokKind.Duration, text + unit, start, text + unit);
    }
    return this.make(TokKind.Number, text, start, Number(text));
  }

  private readWord(start: Pos): Token {
    let text = "";
    while (isIdentPart(this.peekChar())) text += this.advance();
    const keyword = KEYWORDS.get(text.toLowerCase());
    if (keyword !== undefined) {
      if (keyword === TokKind.True) return this.make(keyword, text, start, true);
      if (keyword === TokKind.False) return this.make(keyword, text, start, false);
      return this.make(keyword, text, start);
    }
    return this.make(TokKind.Ident, text, start, text);
  }

  private readOperator(start: Pos): Token {
    const ch = this.peekChar();
    const two = ch + this.peekChar(1);

    if (two === "!=") {
      this.advance();
      this.advance();
      return this.make(TokKind.Neq, two, start);
    }
    if (two === "<=") {
      this.advance();
      this.advance();
      return this.make(TokKind.Lte, two, start);
    }
    if (two === ">=") {
      this.advance();
      this.advance();
      return this.make(TokKind.Gte, two, start);
    }
    if (two === "==") {
      this.advance();
      this.advance();
      return this.make(TokKind.EqEq, two, start);
    }
    if (ch === "=") {
      this.advance();
      return this.make(TokKind.Eq, ch, start);
    }
    if (ch === "<") {
      this.advance();
      return this.make(TokKind.Lt, ch, start);
    }
    if (ch === ">") {
      this.advance();
      return this.make(TokKind.Gt, ch, start);
    }

    const single = SINGLE_CHAR_TOKENS.get(ch);
    if (single !== undefined) {
      this.advance();
      return this.make(single, ch, start);
    }

    this.advance();
    throw new SemError(DiagCode.LexError, `unexpected character '${ch}'`, { start, end: this.pos() });
  }
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}
