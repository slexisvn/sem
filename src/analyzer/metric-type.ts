import { Additivity, fromReAgg, meetAdditivity, NON_ADDITIVE } from "../config/additivity.js";
import { aggReAgg } from "../config/aggregates.js";
import { ArithOp } from "../config/constants.js";
import { DIMENSIONLESS, divUnit, formatUnit, mulUnit, Unit, unitEquals } from "../config/units.js";
import { DiagCode, SemError } from "../diagnostics/diagnostic.js";
import { Span } from "../lexer/token.js";
import { MExpr } from "./ir.js";

export interface MetricType {
  readonly unit: Unit | undefined;
  readonly add: Additivity;
}

export function typeOf(expr: MExpr, span: Span): MetricType {
  switch (expr.k) {
    case "agg":
      return { unit: expr.unit, add: expr.add ?? fromReAgg(aggReAgg(expr.func, expr.distinct)) };
    case "num":
      return { unit: DIMENSIONLESS, add: NON_ADDITIVE };
    case "bin":
      return combine(expr.op, typeOf(expr.left, span), typeOf(expr.right, span), span);
  }
}

const ADDITION_VERB: ReadonlyMap<ArithOp, string> = new Map([
  [ArithOp.Add, "add"],
  [ArithOp.Sub, "subtract"]
]);

function combine(op: ArithOp, left: MetricType, right: MetricType, span: Span): MetricType {
  if (op === ArithOp.Add || op === ArithOp.Sub) {
    return { unit: additiveUnit(left.unit, right.unit, op, span), add: meetAdditivity(left.add, right.add) };
  }
  const project = op === ArithOp.Mul ? mulUnit : divUnit;
  return { unit: derivedUnit(left.unit, right.unit, project), add: NON_ADDITIVE };
}

function additiveUnit(a: Unit | undefined, b: Unit | undefined, op: ArithOp, span: Span): Unit | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (!unitEquals(a, b)) {
    throw new SemError(
      DiagCode.UnitMismatch,
      `cannot ${ADDITION_VERB.get(op)!} metrics with units '${formatUnit(a)}' and '${formatUnit(b)}'`,
      span
    );
  }
  return a;
}

function derivedUnit(a: Unit | undefined, b: Unit | undefined, project: (a: Unit, b: Unit) => Unit): Unit | undefined {
  return a === undefined || b === undefined ? undefined : project(a, b);
}
