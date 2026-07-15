import { describe, expect, test } from "vitest";
import { NodeKind, parseModels, parseQuery, tokenize, TokKind } from "../src/index.js";

describe("lexer", () => {
  test("tokenizes a metric line into a real token stream", () => {
    const kinds = tokenize("metric revenue = sum(amount) where status = 'paid'").map((t) => t.kind);
    expect(kinds).toEqual([
      TokKind.Metric,
      TokKind.Ident,
      TokKind.Eq,
      TokKind.Ident,
      TokKind.LParen,
      TokKind.Ident,
      TokKind.RParen,
      TokKind.Where,
      TokKind.Ident,
      TokKind.Eq,
      TokKind.String,
      TokKind.Eof
    ]);
  });

  test("tracks line and column positions", () => {
    const tokens = tokenize("show\n  revenue");
    expect(tokens[1]!.span.start).toMatchObject({ line: 2, column: 3 });
  });

  test("skips comments and reads two-char operators", () => {
    const kinds = tokenize("a >= 3 # trailing comment\n").map((t) => t.kind);
    expect(kinds).toEqual([TokKind.Ident, TokKind.Gte, TokKind.Number, TokKind.Eof]);
  });

  test("handles escaped quotes inside strings", () => {
    const token = tokenize("'it''s'")[0]!;
    expect(token.kind).toBe(TokKind.String);
    expect(token.value).toBe("it's");
  });
});

describe("parser", () => {
  test("builds a typed model AST", () => {
    const [model] = parseModels(
      "model Orders { table public.orders primary_key id metric revenue = sum(amount) where status = 'paid' }"
    );
    expect(model!.name).toBe("Orders");
    expect(model!.table).toBe("public.orders");
    expect(model!.primaryKey).toBe("id");
    expect(model!.metrics[0]!.name).toBe("revenue");
    expect(model!.metrics[0]!.filter?.kind).toBe(NodeKind.Binary);
  });

  test("parses metric arithmetic with correct precedence", () => {
    const [model] = parseModels("model M { table t primary_key id metric x = a + b / c }");
    const expr = model!.metrics[0]!.expr;
    expect(expr.kind).toBe(NodeKind.Binary);
    if (expr.kind === NodeKind.Binary) {
      expect(expr.op).toBe("+");
      expect(expr.right.kind).toBe(NodeKind.Binary);
    }
  });

  test("parses the full query grammar", () => {
    const q = parseQuery("show revenue, aov by region where region = 'VN' order by revenue desc top 5");
    expect(q.metrics).toHaveLength(2);
    expect(q.dimensions).toHaveLength(1);
    expect(q.where?.kind).toBe(NodeKind.Binary);
    expect(q.orderBy?.dir).toBe("desc");
    expect(q.top).toBe(5);
  });

  test("reports a parse error with position", () => {
    expect(() => parseQuery("show revenue by")).toThrowError(/parse-error/);
  });

  test("a dimension without '= expr' defaults to the column of the same name", () => {
    const [model] = parseModels("model M { table t primary_key id dimension region: string }");
    const dim = model!.dimensions[0]!;
    expect(dim.name).toBe("region");
    expect(dim.expr.kind).toBe(NodeKind.Ident);
    if (dim.expr.kind === NodeKind.Ident) expect(dim.expr.name).toBe("region");
  });

  test("the shorthand maps to the same column as the explicit self-mapping", () => {
    const shorthand = parseModels("model M { table t primary_key id dimension region: string }")[0]!.dimensions[0]!.expr;
    const explicit = parseModels("model M { table t primary_key id dimension region: string = region }")[0]!.dimensions[0]!.expr;
    expect(shorthand.kind).toBe(explicit.kind);
    if (shorthand.kind === NodeKind.Ident && explicit.kind === NodeKind.Ident) {
      expect(shorthand.name).toBe(explicit.name);
    }
  });
});
