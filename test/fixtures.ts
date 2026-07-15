import { Catalog, compileWithCatalog, parseModels } from "../src/index.js";

export const MODELS = `
model Orders {
  table public.orders
  primary_key id

  join Customers on customer_id = Customers.id (many_to_one)
  join Items on id = Items.order_id (one_to_many)

  dimension region: string = region
  dimension status: string = status
  dimension ordered_at: time = ordered_at

  measure gross = sum(amount)
  measure cnt = count(id)

  metric revenue = sum(amount) where status = 'paid'
  metric refunds = sum(amount) where status = 'refunded'
  metric net_revenue = revenue - refunds
  metric orders = count(id)
  metric aov = revenue / orders
  metric roas = revenue / ad_spend
}

model Customers {
  table public.customers
  primary_key id

  dimension country: string = country
  dimension tier: string = tier
}

model AdSpend {
  table public.ad_spend
  primary_key id

  dimension region: string = region

  measure cost_sum = sum(cost)
  metric ad_spend = sum(cost)
}

model Items {
  table public.items
  primary_key id

  dimension sku: string = sku
}
`;

export function catalog(): Catalog {
  return Catalog.build(parseModels(MODELS));
}

export function run(query: string) {
  return compileWithCatalog(catalog(), query);
}

export const CHAIN = `
model LineItems {
  table public.line_items
  primary_key id
  join Orders on order_id = Orders.id (many_to_one)
  metric units = sum(qty)
}
model Orders {
  table public.orders
  primary_key id
  join Customers on customer_id = Customers.id (many_to_one)
  dimension status: string = status
}
model Customers {
  table public.customers
  primary_key id
  dimension country: string = country
}
`;

export const GOVERNED = `
model Orders {
  table public.orders
  primary_key id
  join Items on id = Items.order_id (one_to_many)
  dimension region: string = region
  dimension status: string = status
  dimension ordered_at: time = ordered_at
  metric revenue = sum(amount) where status = 'paid'
  metric orders = count(id)
  metric units = count(Items.id)
}
model Items {
  table public.items
  primary_key id
  dimension sku: string = sku
}
policy analyst_vn on Orders restrict region = 'VN'
assert revenue where ordered_at.month = '2026-01' == 1250000
assert orders where region = 'VN' between 20 and 60
`;

