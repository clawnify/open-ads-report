// Sample/preview data. Served when no ad platform is connected so the dashboard
// looks alive inside the Clawnify iframe before credentials are wired. Numbers
// mirror the design mocks; everything routes through the same metric helpers so
// the shapes are identical to live data.

import type { AccountRef, AccountReport, AccountSummary, DailyPoint, DateRange, Issue, Platform } from "./providers/types";
import { buildKpis, metrics, sumMetrics } from "./metrics";

interface Seed {
  id: string;
  name: string;
  platform: Platform;
  spend: number;
  roas: number;
  conversions: number;
  ctr: number; // percent
  clicks: number;
}

// Sorted worst-to-best ROAS, as the portfolio table renders.
const SEEDS: Seed[] = [
  { id: "act_910100001", name: "Cinder Gaming", platform: "meta", spend: 4150.8, roas: 0.6, conversions: 14, ctr: 0.9, clicks: 1450 },
  { id: "100200300", name: "Drift Apparel", platform: "google", spend: 2980.5, roas: 0.9, conversions: 15, ctr: 1.1, clicks: 1300 },
  { id: "100200301", name: "Acme E-commerce", platform: "google", spend: 4220.1, roas: 1.2, conversions: 27, ctr: 2.1, clicks: 1280 },
  { id: "act_910100002", name: "Pulse Retail", platform: "meta", spend: 6720.8, roas: 1.4, conversions: 68, ctr: 1.9, clicks: 6200 },
  { id: "100200302", name: "Orbit Travel", platform: "google", spend: 3410.3, roas: 1.6, conversions: 30, ctr: 1.7, clicks: 1700 },
  { id: "act_910100003", name: "Zenith Tech", platform: "meta", spend: 5210.6, roas: 1.8, conversions: 60, ctr: 2.2, clicks: 2700 },
  { id: "100200303", name: "Nova SaaS", platform: "google", spend: 8910.2, roas: 2.1, conversions: 63, ctr: 1.4, clicks: 4400 },
  { id: "100200304", name: "Flux Media", platform: "google", spend: 2810.9, roas: 3.2, conversions: 48, ctr: 2.4, clicks: 2400 },
  { id: "482910384", name: "Vertex Finance", platform: "google", spend: 12420.6, roas: 3.8, conversions: 295, ctr: 2.8, clicks: 6390 },
  { id: "act_910100004", name: "Peak Healthcare", platform: "meta", spend: 3120.4, roas: 4.2, conversions: 89, ctr: 1.8, clicks: 2166 },
];

function seedMetrics(s: Seed) {
  const impressions = Math.round(s.clicks / (s.ctr / 100));
  return metrics({
    spend: s.spend,
    revenue: s.spend * s.roas,
    conversions: s.conversions,
    clicks: s.clicks,
    impressions,
  });
}

function summary(s: Seed): AccountSummary {
  const cur = seedMetrics(s);
  // Prior period: nudge down ~6% so deltas read as gentle growth.
  const prev = metrics({
    spend: cur.spend * 0.94,
    revenue: cur.revenue * 0.9,
    conversions: cur.conversions * 0.95,
    clicks: cur.clicks * 0.96,
    impressions: cur.impressions * 0.95,
  });
  return { id: s.id, name: s.name, platform: s.platform, currency: "USD", metrics: cur, prev };
}

export const sampleAccountRefs = (): AccountRef[] =>
  SEEDS.map((s) => ({ id: s.id, name: s.name, platform: s.platform, currency: "USD" }));

const SAMPLE_ISSUES: Record<string, Issue[]> = {
  "Acme E-commerce": [
    {
      id: "conv-tracking",
      title: "Conversion tracking broken",
      detail: "No conversions recorded in 72 hours despite 1,240 clicks. The GTM tag is misfiring on the checkout success page.",
      action: "Verify the conversion tag in GTM and fire a manual test purchase to confirm it records in Google Ads.",
      severity: "high",
    },
    {
      id: "feed-disapprovals",
      title: "Shopping feed disapprovals climbing",
      detail: "142 products disapproved over the last 7 days — missing GTIN and incorrect availability flags.",
      action: "Re-sync the Merchant Center feed and add GTINs from the product database for the disapproved SKUs.",
      severity: "high",
    },
  ],
  "Cinder Gaming": [
    {
      id: "roas-collapse",
      title: "Campaigns are deep underwater",
      detail: "ROAS of 0.6x means $4.2K of spend returned about $2.5K — the account is losing money every day it runs.",
      action: "Pause the bottom three ad sets immediately and consolidate budget into the single best-performing audience.",
      severity: "high",
    },
  ],
  "Drift Apparel": [
    {
      id: "broad-waste",
      title: "Broad match is draining budget",
      detail: "Broad-match keywords are capturing irrelevant queries with a 1.1% CTR and almost no conversions.",
      action: "Add 20+ exact negatives and switch the worst broad terms to phrase match.",
      severity: "medium",
    },
  ],
  "Vertex Finance": [
    {
      id: "qs-drop",
      title: "Quality Scores dropping",
      detail: "Average Quality Score is down from 7.2 to 5.1 over the last 30 days, hurting ad rank and inflating CPCs.",
      action: "Group keywords by intent and rewrite ad copy + landing-page headlines to match top-funnel queries.",
      severity: "medium",
    },
  ],
};

function dailySeries(range: DateRange, totals: { spend: number; revenue: number; conversions: number; clicks: number; impressions: number }): DailyPoint[] {
  const days = range.days;
  // Deterministic weekday-ish weights so the chart has texture but is stable.
  const weights = Array.from({ length: days }, (_, i) => 0.7 + 0.6 * Math.abs(Math.sin(i * 1.3)) + (i % 7 === 5 || i % 7 === 6 ? -0.15 : 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const start = new Date(range.since + "T00:00:00Z");
  return weights.map((w, i) => {
    const f = w / wsum;
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const m = metrics({
      spend: totals.spend * f,
      revenue: totals.revenue * f,
      conversions: totals.conversions * f,
      clicks: totals.clicks * f,
      impressions: totals.impressions * f,
    });
    return {
      date: d.toISOString().split("T")[0],
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
}

export function samplePortfolio(range: DateRange): import("./providers/types").PortfolioReport {
  const accounts = SEEDS.map(summary);
  const totals = sumMetrics(accounts.map((a) => a.metrics));
  const topIssues = accounts
    .slice(0, 3)
    .map((account) => ({ account, issues: SAMPLE_ISSUES[account.name] ?? [] }))
    .filter((t) => t.issues.length > 0);
  return {
    range: { since: range.since, until: range.until, days: range.days },
    totals,
    accounts,
    topIssues,
    generatedAt: new Date().toISOString(),
    preview: true,
  };
}

export function sampleAccountReport(range: DateRange, accountId?: string): AccountReport {
  const seed = SEEDS.find((s) => s.id === accountId) ?? SEEDS.find((s) => s.name === "Vertex Finance")!;
  const sum = summary(seed);
  const cur = sum.metrics;
  const daily = dailySeries(range, {
    spend: cur.spend,
    revenue: cur.revenue,
    conversions: cur.conversions,
    clicks: cur.clicks,
    impressions: cur.impressions,
  });
  return {
    account: { id: seed.id, name: seed.name, platform: seed.platform, currency: "USD" },
    range: { since: range.since, until: range.until, days: range.days },
    kpis: buildKpis(cur, sum.prev),
    daily,
    channels: [{ platform: seed.platform, metrics: cur }],
    issues: SAMPLE_ISSUES[seed.name] ?? [],
    generatedAt: new Date().toISOString(),
    preview: true,
  };
}
