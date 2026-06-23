// Phase 2 — the analyst report engine. A report is a typed document (sections of
// blocks) the app assembles from REAL numbers (KPIs, charts, tables computed
// server-side) plus an AI-authored analysis layer (executive summary, findings,
// recommendations). The app owns the math; the model writes the prose. When no
// OPENROUTER_API_KEY is present it falls back to deterministic heuristics, so the
// report always renders. Analyst, not manager: findings + advice only, no actions.

import type { AccountReport, DailyPoint, Issue, Metrics, Platform } from "./providers/types";
import { deriveIssues } from "./metrics";

// ── Document schema (mirrored client-side in report.tsx) ─────────────────────

export type Severity = "high" | "medium" | "low";
export type Tone = "good" | "warn" | "bad" | "info";

export interface Cell {
  text: string;
  align?: "left" | "right";
  tone?: Tone;
  /** 0..1 — draws a small inline bar behind the value (perf cells). */
  bar?: number;
}

export type Block =
  | { kind: "prose"; text: string }
  | { kind: "kpis"; items: { label: string; value: string; deltaPct?: number | null; higherIsBetter?: boolean }[] }
  | { kind: "chart"; chart: "spend-roas" | "conv-rate" | "clicks-ctr"; barLabel: string; lineLabel: string }
  | { kind: "table"; columns: { label: string; align?: "left" | "right" }[]; rows: Cell[][] }
  | { kind: "findings"; items: { title: string; detail: string; severity: Severity; recommendation?: string }[] }
  | { kind: "recommendations"; items: { text: string; priority: "P0" | "P1" | "P2" }[] }
  | { kind: "callout"; tone: Tone; text: string };

export interface Section {
  /** Uppercase zone label (the design-system eyebrow). */
  eyebrow: string;
  /** Optional right-aligned count/meta shown next to the eyebrow. */
  note?: string;
  blocks: Block[];
}

export interface ReportDoc {
  recipe: string;
  title: string;
  subtitle: string;
  account: { name: string; platform: Platform; currency: string };
  range: { since: string; until: string; days: number };
  health: { label: "Healthy" | "Watch" | "At risk"; tone: Tone; line: string };
  sections: Section[];
  /** Backs the chart blocks (kept once, not per-block). */
  daily: DailyPoint[];
  ai: boolean;
  preview: boolean;
  generatedAt: string;
}

// ── Recipe registry (the "AI analyst" gallery) ───────────────────────────────

export interface RecipeMeta {
  id: string;
  name: string;
  blurb: string;
  /** false → shown in the gallery as "coming soon", not yet generatable. */
  available: boolean;
}

export const RECIPES: RecipeMeta[] = [
  { id: "account-audit", name: "Account Audit", blurb: "Full health check — KPIs, trends, findings, and prioritised fixes.", available: true },
  { id: "search-terms", name: "Search Terms", blurb: "Wasted-spend and negative-keyword opportunities.", available: false },
  { id: "creative-fatigue", name: "Creative Fatigue", blurb: "Declining creatives and what to refresh.", available: false },
  { id: "landing-page", name: "Landing Page Analysis", blurb: "Where conversions leak after the click.", available: false },
];

// ── Formatters (server-side → report carries display strings) ─────────────────

const money = (n: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
const moneyK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(0)}`);
const num = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const pct = (n: number) => `${n.toFixed(1)}%`;
const xroas = (n: number) => `${n.toFixed(1)}x`;
const roasTone = (r: number): Tone => (r >= 2.5 ? "good" : r >= 1 ? "warn" : "bad");

// ── AI analysis layer ────────────────────────────────────────────────────────

interface Analysis {
  summary: string;
  findings: { title: string; detail: string; severity: Severity; recommendation?: string }[];
  recommendations: { text: string; priority: "P0" | "P1" | "P2" }[];
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash-lite";

const SYSTEM = `You are a senior paid-media analyst writing an Account Audit for a client.
You DIAGNOSE and ADVISE — you never execute changes. Ground every claim in the numbers given.
Be decisive and specific; no hedging, no theory, no filler.
Respond ONLY with JSON of this exact shape:
{
  "summary": "2-3 sentences: the account's overall health and the single most important thing to address, with numbers.",
  "findings": [{"title":"short headline","detail":"what's wrong/right and why it matters, with the numbers","severity":"high|medium|low","recommendation":"the specific fix to advise"}],
  "recommendations": [{"text":"one concrete next step the client should take","priority":"P0|P1|P2"}]
}
Give 2-4 findings (most important first) and 2-4 recommendations. If the account is healthy, say so and keep findings light.`;

function snapshot(report: AccountReport): string {
  const k = report.kpis;
  const cur = report.channels[0]?.metrics;
  const d = (m: { value: number; deltaPct: number | null }, unit = "") =>
    `${m.value.toFixed(2)}${unit}${m.deltaPct !== null ? ` (${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(0)}% vs prior)` : ""}`;
  const lines = [
    `Account "${report.account.name}" on ${report.account.platform === "meta" ? "Meta Ads" : "Google Ads"}, last ${report.range.days} days. Currency ${report.account.currency}.`,
    `Spend: ${d(k.cost)}`,
    `ROAS: ${d(k.roas, "x")}`,
    `Conversions: ${d(k.conversions)}`,
    `Conversion rate: ${d(k.convRate, "%")}`,
    `Clicks: ${d(k.clicks)}`,
    `CTR: ${d(k.ctr, "%")}`,
  ];
  if (cur) lines.push(`Revenue: ${cur.revenue.toFixed(0)}, CPA: ${cur.cpa.toFixed(2)}`);
  return lines.join("\n");
}

async function aiAnalysis(apiKey: string, report: AccountReport): Promise<Analysis | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 1100,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: snapshot(report) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const p = JSON.parse(content);
    const sev = (s: any): Severity => (s === "high" || s === "low" ? s : "medium");
    const prio = (s: any): "P0" | "P1" | "P2" => (s === "P0" || s === "P2" ? s : "P1");
    return {
      summary: String(p.summary ?? ""),
      findings: (Array.isArray(p.findings) ? p.findings : []).slice(0, 4).map((f: any) => ({
        title: String(f.title ?? "Finding"),
        detail: String(f.detail ?? ""),
        severity: sev(f.severity),
        recommendation: f.recommendation ? String(f.recommendation) : undefined,
      })),
      recommendations: (Array.isArray(p.recommendations) ? p.recommendations : []).slice(0, 4).map((r: any) => ({
        text: String(r.text ?? ""),
        priority: prio(r.priority),
      })),
    };
  } catch {
    return null;
  }
}

/** Deterministic analysis when no AI key — derived from the same heuristics as the dashboard. */
function heuristicAnalysis(report: AccountReport): Analysis {
  const cur = report.channels[0]?.metrics ?? ({} as Metrics);
  const prev = report.kpis.cost.prev !== null
    ? ({ spend: report.kpis.cost.prev, roas: report.kpis.roas.prev, conversions: report.kpis.conversions.prev,
         convRate: report.kpis.convRate.prev, clicks: report.kpis.clicks.prev, ctr: report.kpis.ctr.prev } as any)
    : null;
  const issues: Issue[] = deriveIssues(cur, prev, report.daily);
  const roas = report.kpis.roas.value;
  const summary =
    roas >= 2.5
      ? `The account is healthy at ${xroas(roas)} ROAS over ${report.range.days} days. Focus on scaling the top performers without diluting return.`
      : roas >= 1
        ? `The account is profitable but thin at ${xroas(roas)} ROAS. The priority is lifting return before adding spend.`
        : `The account is losing money at ${xroas(roas)} ROAS — every dollar spent returns less than a dollar. Cut waste before anything else.`;
  return {
    summary,
    findings: issues.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity, recommendation: i.action })),
    recommendations: issues.slice(0, 3).map((i, idx) => ({
      text: i.action,
      priority: i.severity === "high" ? "P0" : i.severity === "medium" ? "P1" : "P2",
    })) as Analysis["recommendations"],
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

function kpiBlock(report: AccountReport, currency: string): Block {
  const k = report.kpis;
  return {
    kind: "kpis",
    items: [
      { label: "Cost", value: money(k.cost.value, currency), deltaPct: k.cost.deltaPct, higherIsBetter: true },
      { label: "ROAS", value: xroas(k.roas.value), deltaPct: k.roas.deltaPct, higherIsBetter: true },
      { label: "Conversions", value: num(k.conversions.value), deltaPct: k.conversions.deltaPct, higherIsBetter: true },
      { label: "Conv. Rate", value: pct(k.convRate.value), deltaPct: k.convRate.deltaPct, higherIsBetter: true },
      { label: "Clicks", value: num(k.clicks.value), deltaPct: k.clicks.deltaPct, higherIsBetter: true },
      { label: "CTR", value: pct(k.ctr.value), deltaPct: k.ctr.deltaPct, higherIsBetter: true },
    ],
  };
}

function channelTable(report: AccountReport, currency: string): Block {
  return {
    kind: "table",
    columns: [
      { label: "Channel", align: "left" },
      { label: "Spend", align: "right" },
      { label: "ROAS", align: "right" },
      { label: "Conv. Rate", align: "right" },
      { label: "Conversions", align: "right" },
    ],
    rows: report.channels.map((c) => [
      { text: c.platform === "meta" ? "Meta" : "Google Ads", align: "left" },
      { text: money(c.metrics.spend, currency), align: "right" },
      { text: xroas(c.metrics.roas), align: "right", tone: roasTone(c.metrics.roas), bar: Math.min(1, c.metrics.roas / 5) },
      { text: pct(c.metrics.convRate), align: "right" },
      { text: num(c.metrics.conversions), align: "right" },
    ]),
  };
}

const HEALTH = (roas: number): ReportDoc["health"] =>
  roas >= 2.5
    ? { label: "Healthy", tone: "good", line: `${xroas(roas)} ROAS — returning strongly on spend.` }
    : roas >= 1
      ? { label: "Watch", tone: "warn", line: `${xroas(roas)} ROAS — profitable but below a 2.5x target.` }
      : { label: "At risk", tone: "bad", line: `${xroas(roas)} ROAS — spending more than it returns.` };

const fmtRange = (since: string, until: string) => {
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${new Date(since + "T00:00:00").toLocaleDateString("en-US", o)} – ${new Date(until + "T00:00:00").toLocaleDateString("en-US", o)}`;
};

/** Build the Account Audit report from a computed AccountReport. */
export async function generateReport(
  recipe: string,
  report: AccountReport,
  apiKey: string | null,
): Promise<ReportDoc> {
  const currency = report.account.currency;
  const aiResult = apiKey ? await aiAnalysis(apiKey, report) : null;
  const analysis = aiResult ?? heuristicAnalysis(report);
  const usedAi = aiResult !== null;
  const health = HEALTH(report.kpis.roas.value);

  const sections: Section[] = [
    {
      eyebrow: "Executive Summary",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    { eyebrow: "Headline Metrics", note: `${report.range.days} days`, blocks: [kpiBlock(report, currency)] },
    {
      eyebrow: "Performance Trends",
      blocks: [
        { kind: "chart", chart: "spend-roas", barLabel: "Cost", lineLabel: "ROAS" },
        { kind: "chart", chart: "conv-rate", barLabel: "Conversions", lineLabel: "Conv. Rate" },
        { kind: "chart", chart: "clicks-ctr", barLabel: "Clicks", lineLabel: "CTR" },
      ],
    },
    { eyebrow: "Channel Breakdown", blocks: [channelTable(report, currency)] },
  ];

  if (analysis.findings.length) {
    sections.push({
      eyebrow: "Key Findings",
      note: `${analysis.findings.length}`,
      blocks: [{ kind: "findings", items: analysis.findings }],
    });
  }
  if (analysis.recommendations.length) {
    sections.push({
      eyebrow: "Recommendations",
      note: `${analysis.recommendations.length}`,
      blocks: [{ kind: "recommendations", items: analysis.recommendations }],
    });
  }

  return {
    recipe,
    title: "Account Audit",
    subtitle: `${report.account.name} · ${fmtRange(report.range.since, report.range.until)}`,
    account: { name: report.account.name, platform: report.account.platform, currency },
    range: report.range,
    health,
    sections,
    daily: report.daily,
    ai: usedAi,
    preview: report.preview,
    generatedAt: new Date().toISOString(),
  };
}
