import { describe, expect, test } from "vitest";
import { compile, DiagCode } from "../src/index.js";

const GEO = `
model Orders {
  table public.orders
  primary_key id
  dimension country: string = country
  dimension region: string = region
  dimension city: string = city
  dimension status: string = status
  dimension ordered_at: time = ordered_at
  hierarchy geo = country > region > city
  measure gross : money = sum(amount)
  metric revenue = gross
}
`;

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const partitionOf = (query: string, models: string = GEO): string => {
  const sql = compile(models, query).sql;
  return /OVER \(([^)]*)\)/.exec(sql)?.[1] ?? "";
};

describe("a hierarchy lets one query follow a drill down", () => {
  const share = (by: string) => partitionOf(`show revenue / revenue.of(geo) as share_of_parent by ${by}`);

  test("at the finest level the subtotal is the level above it", () => {
    expect(share("country, region, city")).toBe("PARTITION BY region");
  });

  test("drilling up one level moves the subtotal up with it", () => {
    expect(share("country, region")).toBe("PARTITION BY country");
  });

  test("at the coarsest level there is no parent, so the subtotal is the grand total", () => {
    expect(share("country")).toBe("");
  });

  test("the levels above need not all be grouped for the nearest one to win", () => {
    expect(share("region, city")).toBe("PARTITION BY region");
  });

  test("a skipped level falls through to the nearest coarser level that is grouped", () => {
    expect(share("country, city")).toBe("PARTITION BY country");
  });

  test("a lone finest level has nothing coarser to subtotal against, so it is the grand total", () => {
    expect(share("city")).toBe("");
  });

  test("dimensions outside the hierarchy do not disturb the parent it picks", () => {
    expect(share("region, city, status")).toBe("PARTITION BY region");
  });

  test("share reads the hierarchy the same way of does", () => {
    expect(partitionOf("show revenue.share(geo) by country, region")).toBe("PARTITION BY country");
  });

  test("naming a level directly still means exactly that level", () => {
    expect(partitionOf("show revenue.of(country) by country, region, city")).toBe("PARTITION BY country");
  });
});

describe("a hierarchy is checked when it is declared", () => {
  const build = (levels: string) => () => compile(GEO.replace("country > region > city", levels), "show revenue by region");

  test("a level that is not a dimension of the model is rejected", () => {
    expect(codeOf(build("country > nope"))).toBe(DiagCode.UnknownDimension);
  });

  test("a hierarchy of one level describes no drill, so it is rejected", () => {
    expect(codeOf(build("country"))).toBe(DiagCode.InvalidDefinition);
  });

  test("a repeated level would make the parent ambiguous and is rejected", () => {
    expect(codeOf(build("country > region > country"))).toBe(DiagCode.DuplicateName);
  });

  test("a time dimension is rejected, because grains already nest", () => {
    expect(codeOf(build("country > ordered_at"))).toBe(DiagCode.InvalidDefinition);
  });

  test("two hierarchies with the same name in one model are rejected", () => {
    const dup = GEO.replace("hierarchy geo = country > region > city", "hierarchy geo = country > region\n  hierarchy geo = region > city");
    expect(codeOf(() => compile(dup, "show revenue by region"))).toBe(DiagCode.DuplicateName);
  });
});

describe("using a hierarchy where it cannot mean anything", () => {
  test("a subtotal needs at least one of its levels grouped", () => {
    expect(codeOf(() => compile(GEO, "show revenue.of(geo) by status"))).toBe(DiagCode.UnknownDimension);
  });

  test("the refusal spells out the levels it looked for", () => {
    expect(() => compile(GEO, "show revenue.of(geo) by status")).toThrow(/country > region > city/);
  });

  test("a name that is neither dimension nor hierarchy is still an unknown dimension", () => {
    expect(codeOf(() => compile(GEO, "show revenue.of(nonsense) by region"))).toBe(DiagCode.UnknownDimension);
  });
});
