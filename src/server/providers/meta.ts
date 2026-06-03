// Meta Ads provider. Maps the Graph API Insights endpoints into the normalized
// shapes in types.ts. Credentials come from connect("metaads") — no token
// plumbing here; the SDK injects the bearer token on every call.

import type { AccountRef, AccountReport, AccountSummary, AdProvider, DailyPoint, DateRange, Metrics } from "./types";
import { connect, isConnected, type ConnectionsEnv, type MetaAdsClient } from "@clawnify/connections";
import { buildKpis, deriveIssues, emptyMetrics, metrics } from "../metrics";

const INSIGHT_FIELDS = "spend,impressions,clicks,actions,action_values";

type MetaAction = { action_type: string; value: string };
type InsightRow = {
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
};

function pickAction(arr: MetaAction[] | undefined, type: string): number {
  const omni = arr?.find((a) => a.action_type === `omni_${type}`);
  const direct = arr?.find((a) => a.action_type === type);
  return +((omni ?? direct)?.value ?? 0);
}

function rowMetrics(row: InsightRow): Metrics {
  return metrics({
    spend: +(row.spend ?? 0),
    revenue: pickAction(row.action_values, "purchase"),
    conversions: pickAction(row.actions, "purchase"),
    clicks: +(row.clicks ?? 0),
    impressions: +(row.impressions ?? 0),
  });
}

const timeRange = (since: string, until: string) => JSON.stringify({ since, until });

async function accountInsights(client: MetaAdsClient, accountId: string, since: string, until: string): Promise<Metrics> {
  const data = await client.get(`/${accountId}/insights`, {
    fields: INSIGHT_FIELDS,
    time_range: timeRange(since, until),
    level: "account",
  });
  const row = (data.data ?? [])[0] as InsightRow | undefined;
  return row ? rowMetrics(row) : emptyMetrics();
}

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
    const data = await this.client.get("/me/adaccounts", {
      fields: "name,id,currency,account_status",
      limit: "100",
    });
    return ((data.data ?? []) as any[])
      .filter((a) => a.account_status === 1)
      .map((a) => ({ id: a.id, name: a.name, platform: "meta" as const, currency: a.currency ?? "USD" }));
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          accountInsights(this.client, acc.id, range.since, range.until),
          accountInsights(this.client, acc.id, range.prevSince, range.prevUntil),
        ]);
        return { ...acc, metrics: cur, prev };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [meta, cur, prev, dailyRaw] = await Promise.all([
      this.client.get(`/${id}`, { fields: "name,currency" }),
      accountInsights(this.client, id, range.since, range.until),
      accountInsights(this.client, id, range.prevSince, range.prevUntil),
      this.client.get(`/${id}/insights`, {
        fields: INSIGHT_FIELDS,
        time_range: timeRange(range.since, range.until),
        time_increment: "1",
        level: "account",
      }),
    ]);

    const account: AccountRef = {
      id,
      name: meta.name ?? id,
      platform: "meta",
      currency: meta.currency ?? "USD",
    };

    const daily: DailyPoint[] = ((dailyRaw.data ?? []) as InsightRow[]).map((row) => {
      const m = rowMetrics(row);
      return {
        date: row.date_start!,
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
      channels: [{ platform: "meta", metrics: cur }],
      issues: deriveIssues(cur, prev, daily),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }
}
