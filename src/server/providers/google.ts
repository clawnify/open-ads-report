// Google Ads provider. Two backends:
//
//   1. Composio managed tools (production) — runs GOOGLEADS_SEARCH_STREAM_GAQL via
//      the credentials worker's executeTool RPC. Composio holds the developer
//      token, so the app needs no dev token of its own. This is the default
//      whenever a googleads connection exists and the binding supports executeTool.
//
//   2. Direct REST (local dev) — calls googleads.googleapis.com with an OAuth
//      token + our own developer token + login-customer-id from env.
//
// Both paths normalize into the shapes in types.ts.

import type { AccountRef, AccountReport, AccountSummary, AdProvider, DailyPoint, DateRange, Metrics } from "./types";
import { getGoogleAuth, getComposioExecutor, isServiceConnected, type GoogleAuth, type ToolExecutor } from "../credentials";
import { buildKpis, deriveIssues, emptyMetrics, metrics } from "../metrics";

const DEFAULT_VERSION = "v21";
const N = (v: unknown) => Number(v ?? 0);
const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null) return o[k];
  return undefined;
};

function pretty(id: string) {
  const d = id.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : id;
}

interface GoogleRow {
  customer?: { id?: string; descriptiveName?: string; descriptive_name?: string; currencyCode?: string; currency_code?: string; manager?: boolean };
  segments?: { date?: string };
  metrics?: Record<string, unknown>;
}

function rowMetrics(row: GoogleRow): Metrics {
  const m = (row.metrics ?? {}) as any;
  return metrics({
    spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
    revenue: N(pick(m, "conversionsValue", "conversions_value")),
    conversions: N(pick(m, "conversions")),
    clicks: N(pick(m, "clicks")),
    impressions: N(pick(m, "impressions")),
  });
}

const customerName = (row?: GoogleRow, fallbackId = "") =>
  pick(row?.customer ?? {}, "descriptiveName", "descriptive_name") || pretty(fallbackId);
const customerCurrency = (row?: GoogleRow) =>
  pick(row?.customer ?? {}, "currencyCode", "currency_code") || "USD";

// ── Response parsing (tolerant of Composio + native shapes) ──────────────────

function unwrap(data: unknown): any {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

/** Flatten any plausible searchStream result shape into rows. */
function resultRows(data: unknown): GoogleRow[] {
  const d = unwrap(data);
  if (!d) return [];
  if (Array.isArray(d)) {
    if (d.length && (d[0]?.results || d[0]?.result)) return d.flatMap((b: any) => b.results ?? b.result ?? []);
    return d as GoogleRow[];
  }
  if (Array.isArray(d.results)) return d.results;
  if (d.data) return resultRows(d.data);
  if (d.response) return resultRows(d.response);
  return [];
}

const QUERIES = {
  customer: "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer",
  totals: (since: string, until: string) =>
    `SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  daily: (since: string, until: string) =>
    `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`,
};

type Backend =
  | { kind: "composio"; exec: ToolExecutor }
  | { kind: "direct"; auth: GoogleAuth; version: string };

export class GoogleProvider implements AdProvider {
  readonly id = "google" as const;
  constructor(private backend: Backend) {}

  static async create(env: Record<string, string>): Promise<GoogleProvider | null> {
    // Prefer Composio managed tools when the connection exists and the binding
    // can execute tools — no developer token required.
    const exec = getComposioExecutor("googleads");
    if (exec && (await isServiceConnected("googleads"))) {
      return new GoogleProvider({ kind: "composio", exec });
    }
    // Local-dev fallback: direct REST with our own developer token.
    const auth = await getGoogleAuth();
    if (auth) return new GoogleProvider({ kind: "direct", auth, version: env.GOOGLEADS_API_VERSION || DEFAULT_VERSION });
    return null;
  }

  isConnected() {
    return true;
  }

  // ── Backend-agnostic GAQL ──
  // In Composio mode the connection targets its configured customer, so the
  // customerId is only used by the direct backend.
  private async gaql(customerId: string, query: string): Promise<GoogleRow[]> {
    if (this.backend.kind === "composio") {
      const data = await this.backend.exec("GOOGLEADS_SEARCH_STREAM_GAQL", { query });
      return resultRows(data);
    }
    const cid = customerId.replace(/\D/g, "");
    const res = await fetch(
      `https://googleads.googleapis.com/${this.backend.version}/customers/${cid}/googleAds:searchStream`,
      { method: "POST", headers: this.directHeaders(), body: JSON.stringify({ query }) },
    );
    const data = (await res.json()) as any;
    if (!res.ok) {
      const msg = Array.isArray(data) ? data[0]?.error?.message : data?.error?.message;
      throw new Error(msg ?? `Google Ads API error ${res.status}`);
    }
    return resultRows(data);
  }

  private directHeaders(): Record<string, string> {
    const a = (this.backend as Extract<Backend, { kind: "direct" }>).auth;
    const h: Record<string, string> = {
      Authorization: `Bearer ${a.accessToken}`,
      "developer-token": a.developerToken,
      "Content-Type": "application/json",
    };
    if (a.loginCustomerId) h["login-customer-id"] = a.loginCustomerId;
    return h;
  }

  private async accessibleCustomerIds(): Promise<string[]> {
    if (this.backend.kind === "composio") {
      const data = unwrap(await this.backend.exec("GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS", {}));
      const names: unknown =
        data?.resourceNames ?? data?.resource_names ?? data?.data?.resourceNames ?? (Array.isArray(data) ? data : []);
      return ((names as string[]) ?? []).map((rn) => String(rn).split("/")[1] ?? String(rn)).map((s) => s.replace(/\D/g, "")).filter(Boolean);
    }
    const res = await fetch(
      `https://googleads.googleapis.com/${this.backend.version}/customers:listAccessibleCustomers`,
      { headers: this.directHeaders() },
    );
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(data?.error?.message ?? `Google Ads API error ${res.status}`);
    return ((data.resourceNames ?? []) as string[]).map((rn) => rn.split("/")[1]);
  }

  async listAccounts(): Promise<AccountRef[]> {
    if (this.backend.kind === "composio") {
      // The managed connection queries its configured customer; surface that one.
      const rows = await this.gaql("", QUERIES.customer);
      const row = rows[0];
      const id = String(pick(row?.customer ?? {}, "id") ?? "");
      if (!id) return [];
      return [{ id, name: customerName(row, id), platform: "google", currency: customerCurrency(row) }];
    }
    // Direct mode: enumerate accessible non-manager customers.
    const ids = await this.accessibleCustomerIds();
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
      id: (String(pick(info[0]?.customer ?? {}, "id") ?? accountId)).replace(/\D/g, ""),
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
