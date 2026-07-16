export interface Pos {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface Span {
  readonly start: Pos;
  readonly end: Pos;
}

export enum TokKind {
  Ident = "IDENT",
  Number = "NUMBER",
  String = "STRING",
  Duration = "DURATION",

  Model = "MODEL",
  Table = "TABLE",
  PrimaryKey = "PRIMARY_KEY",
  Timezone = "TIMEZONE",
  FiscalYearStarts = "FISCAL_YEAR_STARTS",
  Join = "JOIN",
  On = "ON",
  Asof = "ASOF",
  Dimension = "DIMENSION",
  Measure = "MEASURE",
  Metric = "METRIC",
  Segment = "SEGMENT",

  Show = "SHOW",
  By = "BY",
  Where = "WHERE",
  Having = "HAVING",
  Order = "ORDER",
  Asc = "ASC",
  Desc = "DESC",
  Top = "TOP",
  Assert = "ASSERT",
  EqEq = "EQEQ",
  Policy = "POLICY",
  Restrict = "RESTRICT",
  Materialize = "MATERIALIZE",
  As = "AS",
  Funnel = "FUNNEL",
  Steps = "STEPS",
  Over = "OVER",
  Retention = "RETENTION",
  Periods = "PERIODS",

  And = "AND",
  Or = "OR",
  Not = "NOT",
  In = "IN",
  Between = "BETWEEN",
  Like = "LIKE",
  True = "TRUE",
  False = "FALSE",

  LBrace = "LBRACE",
  RBrace = "RBRACE",
  LParen = "LPAREN",
  RParen = "RPAREN",
  Comma = "COMMA",
  Dot = "DOT",
  Colon = "COLON",

  Eq = "EQ",
  Neq = "NEQ",
  Lt = "LT",
  Lte = "LTE",
  Gt = "GT",
  Gte = "GTE",
  Plus = "PLUS",
  Minus = "MINUS",
  Star = "STAR",
  Slash = "SLASH",

  Eof = "EOF"
}

export type TokenValue = string | number | boolean;

export interface Token {
  readonly kind: TokKind;
  readonly text: string;
  readonly value?: TokenValue;
  readonly span: Span;
}
