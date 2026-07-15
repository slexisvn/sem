import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Catalog, compileAsserts, compileWithCatalog, materializeDecl, parseProgram } from "../src/index.js";

const SAMPLE_QUERIES: Record<string, string[]> = {
  orders: [
    "show revenue, net_revenue, aov by region",
    "show buyers by Customers.tier",
    "show revenue by Items.sku",
    "show revenue.share by region",
    "show revenue.yoy by ordered_at.month, region",
    "show units by Items.sku"
  ],
  events: [
    "show events, active_users, events_per_user by platform",
    "show active_users by Users.country",
    "show signups by occurred_at.week",
    "show avg_session_seconds by channel"
  ],
  subscriptions: [
    "show mrr, active_subs, arpa by Plans.tier",
    "show accounts by Accounts.industry",
    "show mrr.share by country",
    "show largest_mrr by Plans.name"
  ]
};

function loadExample(name: string): string {
  return readFileSync(new URL(`../examples/${name}.sem`, import.meta.url), "utf8");
}

describe("bundled examples stay valid", () => {
  for (const [name, queries] of Object.entries(SAMPLE_QUERIES)) {
    test(`${name}.sem: models, sample queries, materializes, and asserts all compile`, () => {
      const program = parseProgram(loadExample(name));
      const catalog = Catalog.build(program.models, program.policies);
      for (const query of queries) expect(() => compileWithCatalog(catalog, query), query).not.toThrow();
      for (const view of program.materializes) expect(() => materializeDecl(catalog, view), view.name).not.toThrow();
      expect(() => compileAsserts(catalog, program.asserts)).not.toThrow();
    });
  }

  test("a file may declare several materializes and asserts after one another", () => {
    const program = parseProgram(loadExample("subscriptions"));
    expect(program.materializes.length + program.asserts.length).toBeGreaterThan(1);
  });
});
