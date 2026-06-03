// Google Ads provider. All the backend complexity — managed-action vs direct
// REST, the developer token, GAQL response parsing — now lives inside the
// connect("googleads") client. This provider just runs GAQL and shapes the rows
// into types.ts. `client.singleCustomer` tells us whether the connection targets
// one managed account or we can enumerate accessible accounts.

import type { AccountRef, AccountReport, AccountSummary, AdProvider, DailyPoint, DateRange, Metrics } from "./types";
import { connect, isConnected, type ConnectionsEnv, type GoogleAdsClient, type GoogleAdsRow } from "@clawnify/connections";
import { buildKpis, deriveIssues, emptyMetrics, metrics } from "../metrics";

const N = (v: unknown) => Number(v ?? 0);
const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null) return o[k];
  return undefined;
};

function pretty(id: string) {
  const d = id.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : id;
}

function rowMetrics(row: GoogleAdsRow): Metrics {
  const m = (row.metrics ?? {}) as any;
  return metrics({
    spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
    revenue: N(pick(m, "conversionsValue", "conversions_value")),
    conversions: N(pick(m, "conversions")),
    clicks: N(pick(m, "clicks")),
    impressions: N(pick(m, "impressions")),
  });
}

const customerName = (row?: GoogleAdsRow, fallbackId = "") =>
  pick(row?.customer ?? {}, "descriptiveName", "descriptive_name") || pretty(fallbackId);
const customerCurrency = (row?: GoogleAdsRow) =>
  pick(row?.customer ?? {}, "currencyCode", "currency_code") || "USD";

const QUERIES = {
  customer: "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer",
  totals: (since: string, until: string) =>
    `SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  daily: (since: string, until: string) =>
    `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`,
};

export class GoogleProvider implements AdProvider {
  readonly id = "google" as const;
  constructor(private client: GoogleAdsClient) {}

  static async create(env: ConnectionsEnv): Promise<GoogleProvider | null> {
    if (!(await isConnected("googleads", env))) return null;
    return new GoogleProvider(connect("googleads", env));
  }

  isConnected() {
    return true;
  }

  // In single-customer (managed) mode the connection targets its configured
  // customer, so customerId is only meaningful when enumerating directly.
  private gaql(customerId: string, query: string): Promise<GoogleAdsRow[]> {
    return this.client.query(query, { customerId });
  }

  async listAccounts(): Promise<AccountRef[]> {
    if (this.client.singleCustomer) {
      // Surface the single managed customer the connection targets.
      const rows = await this.gaql("", QUERIES.customer);
      const row = rows[0];
      const id = String(pick(row?.customer ?? {}, "id") ?? "");
      if (!id) return [];
      return [{ id, name: customerName(row, id), platform: "google", currency: customerCurrency(row) }];
    }
    // Enumerate accessible non-manager customers.
    const ids = await this.client.listCustomerIds();
    const refs = await Promise.all(
      ids.map(async (id) => {
        try {
          const rows = await this.gaql(
            id,
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer",
          );
          if (pick(rows[0]?.customer ?? {}, "manager")) return null;
          return { id, name: customerName(rows[0], id), platform: "google" as const, currency: customerCurrency(rows[0]) };
        } catch {
          return null;
        }
      }),
    );
    return refs.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  private async totals(customerId: string, since: string, until: string): Promise<Metrics> {
    const rows = await this.gaql(customerId, QUERIES.totals(since, until));
    return rows[0] ? rowMetrics(rows[0]) : emptyMetrics();
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          this.totals(acc.id, range.since, range.until),
          this.totals(acc.id, range.prevSince, range.prevUntil),
        ]);
        return { ...acc, metrics: cur, prev };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const [info, cur, prev, dailyRows] = await Promise.all([
      this.gaql(accountId, QUERIES.customer),
      this.totals(accountId, range.since, range.until),
      this.totals(accountId, range.prevSince, range.prevUntil),
      this.gaql(accountId, QUERIES.daily(range.since, range.until)),
    ]);

    const account: AccountRef = {
      id: String(pick(info[0]?.customer ?? {}, "id") ?? accountId).replace(/\D/g, ""),
      name: customerName(info[0], accountId),
      platform: "google",
      currency: customerCurrency(info[0]),
    };

    const daily: DailyPoint[] = dailyRows.map((row) => {
      const m = rowMetrics(row);
      return {
        date: pick(row.segments ?? {}, "date") ?? "",
        spend: m.spend,
        revenue: m.revenue,
        conversions: m.conversions,
        clicks: m.clicks,
        impressions: m.impressions,
        roas: m.roas,
        convRate: m.convRate,
        ctr: m.ctr,
      };
    });

    return {
      account,
      range: { since: range.since, until: range.until, days: range.days },
      kpis: buildKpis(cur, prev),
      daily,
      channels: [{ platform: "google", metrics: cur }],
      issues: deriveIssues(cur, prev, daily),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }
}
