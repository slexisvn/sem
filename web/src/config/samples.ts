export const DEFAULT_SCHEMA = `model Orders {
  table orders
  primary_key id

  dimension region: string
  dimension status: string
  dimension ordered_at: time

  measure gross       = sum(amount)
  measure order_count = count(id)
  measure buyer_count = count(distinct customer_id)

  metric revenue = gross where status = 'paid'
  metric refunds = gross where status = 'refunded'
  metric net     = revenue - refunds
  metric orders  = order_count
  metric aov     = revenue / orders
  metric buyers  = buyer_count
}`;

export const DEFAULT_QUERY = `show revenue, orders, aov, buyers by region`;

export const SAMPLE_DATASET = {
  fileName: "orders.csv",
  content: `id,customer_id,region,status,amount,ordered_at
1,10,VN,paid,120.00,2026-01-05
2,10,VN,refunded,40.00,2026-01-11
3,11,US,paid,260.00,2026-01-14
4,12,US,paid,90.00,2026-02-02
5,11,VN,paid,55.00,2026-02-09
6,13,EU,paid,310.00,2026-02-20
7,12,EU,refunded,75.00,2026-03-01
8,10,VN,paid,145.00,2026-03-18`,
} as const;
