import { Expr, NodeKind, RefExpr } from "./nodes.js";

export function printRef(ref: RefExpr): string {
  return ref.kind === NodeKind.Ident ? ref.name : `${printRef(ref.object)}.${ref.name}`;
}

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case NodeKind.Ident:
      return expr.name;
    case NodeKind.Member:
      return `${printExpr(expr.object)}.${expr.name}`;
    case NodeKind.Literal:
      return expr.literalType === "string" ? `'${String(expr.value)}'` : String(expr.value);
    case NodeKind.Call:
      return `${expr.callee}(${expr.args.map(printExpr).join(", ")})`;
    case NodeKind.Binary:
      return `${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)}`;
    case NodeKind.Unary:
      return expr.op === "not" ? `not ${printExpr(expr.operand)}` : `-${printExpr(expr.operand)}`;
    case NodeKind.Between:
      return `${printExpr(expr.value)} between ${printExpr(expr.lower)} and ${printExpr(expr.upper)}`;
    case NodeKind.In:
      return `${printExpr(expr.value)} in (${expr.list.map(printExpr).join(", ")})`;
  }
}
