// Meta Ads provider. All data comes through the connections SDK's semantic
// methods — connect("metaads").adAccounts() / insights() / object() — which route
// through whatever maintainer holds the credential (Composio execute today). The
// app carries NO Graph API URLs, version, or token plumbing: the broker is hidden
// and a future maintainer swap changes the descriptor, not this file.

import type { AccountRef, AccountReport, AccountSummary, AdProvider, DailyPoint, DateRange, Metrics } from "./types";
import { connect, isConnected, type ConnectionsEnv, type MetaAdsClient, type MetaInsightRow } from "@clawnify/connections";
import { buildKpis, deriveIssues, emptyMetrics, metrics } from "../metrics";

type MetaAction = { action_type: string; value: string };

function pickAction(arr: MetaAction[] | undefined, type: string): number {
  const omni = arr?.find((a) => a.action_type === `omni_${type}`);
  const direct = arr?.find((a) => a.action_type === type);
  return +((omni ?? direct)?.value ?? 0);
}

function rowMetrics(row: MetaInsightRow): Metrics {
  return metrics({
    spend: +(row.spend ?? 0),
    revenue: pickAction(row.action_values, "purchase"),
    conversions: pickAction(row.actions, "purchase"),
    clicks: +(row.clicks ?? 0),
    impressions: +(row.impressions ?? 0),
  });
}

const first = (rows: MetaInsightRow[]): Metrics => (rows[0] ? rowMetrics(rows[0]) : emptyMetrics());

export class MetaProvider implements AdProvider {
  readonly id = "meta" as const;
  constructor(private client: MetaAdsClient) {}

  static async create(env: ConnectionsEnv): Promise<MetaProvider | null> {
    if (!(await isConnected("metaads", env))) return null;
    return new MetaProvider(connect("metaads", env));
  }

  isConnected() {
    return true;
  }

  async listAccounts(): Promise<AccountRef[]> {
    const accounts = await this.client.adAccounts("name,currency,account_status");
    return accounts
      .filter((a) => a.account_status === 1)
      .map((a) => ({ id: a.id, name: a.name ?? a.id, platform: "meta" as const, currency: a.currency ?? "USD" }));
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          this.client.insights(acc.id, { level: "account", since: range.since, until: range.until }),
          this.client.insights(acc.id, { level: "account", since: range.prevSince, until: range.prevUntil }),
        ]);
        return { ...acc, metrics: first(cur), prev: prev[0] ? rowMetrics(prev[0]) : null };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [obj, cur, prev, daily] = await Promise.all([
      this.client.object(id, ["name", "currency"]),
      this.client.insights(id, { level: "account", since: range.since, until: range.until }),
      this.client.insights(id, { level: "account", since: range.prevSince, until: range.prevUntil }),
      // Per-day series for the charts (Graph time_increment=1).
      this.client.insights(id, { level: "account", since: range.since, until: range.until, timeIncrement: 1 }),
    ]);

    const curM = first(cur);
    const prevM = prev[0] ? rowMetrics(prev[0]) : null;
    const account: AccountRef = { id, name: obj.name ?? id, platform: "meta", currency: obj.currency ?? "USD" };

    const series: DailyPoint[] = daily
      .filter((row) => row.date_start)
      .map((row) => {
        const m = rowMetrics(row);
        return {
          date: row.date_start!,
          spend: m.spend, revenue: m.revenue, conversions: m.conversions, clicks: m.clicks,
          impressions: m.impressions, roas: m.roas, convRate: m.convRate, ctr: m.ctr,
        };
      });

    return {
      account,
      range: { since: range.since, until: range.until, days: range.days },
      kpis: buildKpis(curM, prevM),
      daily: series,
      channels: [{ platform: "meta", metrics: curM }],
      issues: deriveIssues(curM, prevM, series),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }
}
