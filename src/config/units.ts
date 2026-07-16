export type Unit = ReadonlyMap<string, number>;

export const DIMENSIONLESS: Unit = new Map();

export function baseUnit(name: string): Unit {
  return new Map([[name, 1]]);
}

function combine(a: Unit, b: Unit, sign: number): Unit {
  const result = new Map(a);
  for (const [name, exp] of b) {
    const next = (result.get(name) ?? 0) + sign * exp;
    if (next === 0) result.delete(name);
    else result.set(name, next);
  }
  return result;
}

export function mulUnit(a: Unit, b: Unit): Unit {
  return combine(a, b, 1);
}

export function divUnit(a: Unit, b: Unit): Unit {
  return combine(a, b, -1);
}

export function unitEquals(a: Unit, b: Unit): boolean {
  if (a.size !== b.size) return false;
  for (const [name, exp] of a) {
    if (b.get(name) !== exp) return false;
  }
  return true;
}

export function isDimensionless(unit: Unit): boolean {
  return unit.size === 0;
}

export function formatUnit(unit: Unit): string {
  if (unit.size === 0) return "dimensionless";
  const entries = [...unit].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const numerator: string[] = [];
  const denominator: string[] = [];
  for (const [name, exp] of entries) {
    const magnitude = Math.abs(exp);
    const term = magnitude === 1 ? name : `${name}^${magnitude}`;
    (exp > 0 ? numerator : denominator).push(term);
  }
  const top = numerator.length > 0 ? numerator.join("*") : "1";
  return denominator.length > 0 ? `${top}/${denominator.join("*")}` : top;
}
