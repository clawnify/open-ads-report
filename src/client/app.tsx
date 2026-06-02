import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Calendar, ChevronDown, RefreshCw } from "lucide-react";

// ── Types (mirror src/server/providers/types.ts) ─────────────────────────────

type Platform = "meta" | "google";
type Metrics = {
  spend: number; revenue: number; conversions: number; clicks: number; impressions: number;
  roas: number; cpa: number; ctr: number; convRate: number;
};
type MetricDelta = { value: number; prev: number | null; deltaPct: number | null; higherIsBetter: boolean };
type DailyPoint = {
  date: string; spend: number; revenue: number; conversions: number; clicks: number;
  impressions: number; roas: number; convRate: number; ctr: number;
};
type Issue = { id: string; title: string; detail: string; action: string; severity: "high" | "medium" | "low" };
type AccountRef = { id: string; name: string; platform: Platform; currency: string };
type AccountSummary = AccountRef & { metrics: Metrics; prev: Metrics | null };
type AccountReport = {
  account: AccountRef;
  range: { since: string; until: string; days: number };
  kpis: { cost: MetricDelta; roas: MetricDelta; conversions: MetricDelta; convRate: MetricDelta; clicks: MetricDelta; ctr: MetricDelta };
  daily: DailyPoint[];
  channels: { platform: Platform; metrics: Metrics }[];
  issues: Issue[];
  generatedAt: string;
  preview: boolean;
};
type PortfolioReport = {
  range: { since: string; until: string; days: number };
  totals: Metrics;
  accounts: AccountSummary[];
  topIssues: { account: AccountSummary; issues: Issue[] }[];
  generatedAt: string;
  preview: boolean;
};

// ── Theme ────────────────────────────────────────────────────────────────────

const C = {
  card: "bg-[#FFFCF7] border border-[#EAE3D2]",
  shadow: "shadow-[0_1px_2px_rgba(26,20,16,0.03)]",
  text: "text-[#1A1410]",
  sub: "text-[#7A6F62]",
  faint: "text-[#A89F90]",
  label: "text-[11px] font-semibold text-[#1A1410] tracking-[0.14em] uppercase",
};
const BAR = "#374151";
const LINE = "#F97316";
const GOOD = "#059669";
const BAD = "#963024";

// ── Formatters ───────────────────────────────────────────────────────────────

const money = (n: number, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const moneyK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(1)}`);
const num = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const pct = (n: number) => `${n.toFixed(1)}%`;
const x = (n: number) => `${n.toFixed(1)}x`;

function fmtDay(d: string) {
  const dt = new Date(d + "T00:00:00");
  return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}`;
}
function fmtRange(since: string, until: string) {
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${new Date(since + "T00:00:00").toLocaleDateString("en-US", o)} - ${new Date(until + "T00:00:00").toLocaleDateString("en-US", o)}`;
}
function perfColor(roas: number) {
  return roas >= 2.5 ? "#10B981" : roas >= 1 ? "#FBBF24" : BAD;
}
function ctrColor(ctr: number) {
  return ctr >= 2 ? "#10B981" : ctr >= 1.2 ? "#FBBF24" : BAD;
}

// ── Small UI atoms ───────────────────────────────────────────────────────────

function Delta({ d }: { d: MetricDelta }) {
  if (d.deltaPct === null) return null;
  const up = d.deltaPct >= 0;
  const good = d.higherIsBetter ? up : !up;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="text-[11px] font-medium inline-flex items-center gap-0.5" style={{ color: good ? GOOD : BAD }}>
      <Icon className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
      {Math.abs(d.deltaPct).toFixed(1)}%
    </span>
  );
}

const LOGOS: Record<Platform, string> = {
  meta: "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/meta/default.svg",
  google: "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google-ads/default.svg",
};

function PlatformLogo({ platform, size = 14 }: { platform: Platform; size?: number }) {
  return (
    <img
      src={LOGOS[platform]}
      alt={platform === "meta" ? "Meta" : "Google Ads"}
      width={size}
      height={size}
      className="object-contain shrink-0"
    />
  );
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${C.sub} uppercase tracking-[0.14em] whitespace-nowrap`}>
      <PlatformLogo platform={platform} size={14} />
      {platform === "meta" ? "Meta" : "Google"}
    </span>
  );
}

/** KPI card with two metrics side by side (left + right), optional deltas. */
function KpiCard({
  left, right,
}: {
  left: { label: string; value: string; delta?: MetricDelta };
  right: { label: string; value: string; delta?: MetricDelta };
}) {
  const Cell = ({ m, align }: { m: { label: string; value: string; delta?: MetricDelta }; align: "left" | "right" }) => (
    <div className={align === "right" ? "text-right" : ""}>
      <span className={C.label}>{m.label}</span>
      <div className={`flex items-baseline gap-1.5 mt-0.5 ${align === "right" ? "justify-end" : ""}`}>
        <span className="text-[18px] sm:text-[19px] font-semibold text-[#1A1410] leading-tight tracking-[-0.01em]">{m.value}</span>
        {m.delta && <Delta d={m.delta} />}
      </div>
    </div>
  );
  return (
    <div className={`${C.card} ${C.shadow} rounded-[3px] p-4 flex-1 h-full`}>
      <div className="flex justify-between">
        <Cell m={left} align="left" />
        <Cell m={right} align="right" />
      </div>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div className={`px-4 py-3 rounded-[3px] ${C.card} text-[13px] ${C.text}`}>
      <span className="font-semibold">Just a preview.</span> These are sample numbers so you can see how the dashboard works.
      Your real numbers will show up here once you connect an ads account.
    </div>
  );
}

// ── Combo chart (bars + line, dual axis), hand-rolled SVG ─────────────────────

function ComboChart({
  data, barKey, lineKey, barLabel, lineLabel,
}: {
  data: DailyPoint[];
  barKey: "spend" | "conversions" | "clicks";
  lineKey: "roas" | "convRate" | "ctr";
  barLabel: string;
  lineLabel: string;
}) {
  const W = 560, H = 190;
  const pad = { t: 12, b: 24, l: 4, r: 4 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  if (data.length === 0) return <div className={`${C.card} ${C.shadow} rounded-[3px] p-4 h-44`} />;

  const barMax = Math.max(...data.map((d) => d[barKey]), 1);
  const lineMax = Math.max(...data.map((d) => d[lineKey]), 0.001);
  const n = data.length;
  const slot = cw / n;
  const bw = Math.max(2, Math.min(slot * 0.6, 14));
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const by = (v: number) => pad.t + ch - (v / barMax) * ch;
  const ly = (v: number) => pad.t + ch - (v / lineMax) * ch;
  const linePts = data.map((d, i) => `${cx(i)},${ly(d[lineKey])}`).join(" ");
  const tickEvery = Math.max(1, Math.round(n / 5));

  return (
    <div className={`${C.card} ${C.shadow} rounded-[3px] p-3 sm:p-4`}>
      <div className="flex items-center gap-4 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 inline-block" style={{ background: BAR }} />
          <span className={C.label}>{barLabel}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-0.5 inline-block" style={{ background: LINE }} />
          <span className={C.label}>{lineLabel}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
        {data.map((d, i) => (
          <rect key={i} x={cx(i) - bw / 2} y={by(d[barKey])} width={bw} height={pad.t + ch - by(d[barKey])} fill={BAR} rx={1} />
        ))}
        <polyline points={linePts} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) =>
          i % tickEvery === 0 ? (
            <text key={`t${i}`} x={cx(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="#A89F90">
              {fmtDay(d.date)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// ── Channel table (Account View) ─────────────────────────────────────────────

function ChannelTable({ channels }: { channels: { platform: Platform; metrics: Metrics }[] }) {
  const max = Math.max(...channels.map((c) => c.metrics.spend), 1);
  const Bar = ({ w, color, value }: { w: number; color: string; value: string }) => (
    <div className="flex items-center justify-end gap-2">
      <div className="w-12 sm:w-16 md:w-20 h-1.5 bg-[#F5F1E8] overflow-hidden rounded-[3px]">
        <div className="h-full" style={{ width: `${Math.max(4, w * 100)}%`, background: color }} />
      </div>
      <span className="text-[12px] text-[#1A1410] w-12 text-right">{value}</span>
    </div>
  );
  return (
    <div className={`${C.card} ${C.shadow} rounded-[3px] overflow-x-auto`}>
      <div className="px-3 sm:px-4 min-w-[500px]">
        <div className="grid grid-cols-5 gap-2 py-2 border-b border-[#EAE3D2] items-center">
          <div className={C.label}>Channel</div>
          <div className={`${C.label} text-right`}>Ad Spend</div>
          <div className={`${C.label} text-right`}>ROAS</div>
          <div className={`${C.label} text-right`}>Conv. Rate</div>
          <div className={`${C.label} text-right`}>Conversions</div>
        </div>
        {channels.map((c) => (
          <div key={c.platform} className="grid grid-cols-5 gap-2 py-3 border-b border-[#EAE3D2] last:border-b-0 items-center">
            <div><PlatformBadge platform={c.platform} /></div>
            <Bar w={c.metrics.spend / max} color={BAR} value={moneyK(c.metrics.spend)} />
            <Bar w={Math.min(1, c.metrics.roas / 5)} color={perfColor(c.metrics.roas)} value={x(c.metrics.roas)} />
            <Bar w={Math.min(1, c.metrics.convRate / 10)} color={BAR} value={pct(c.metrics.convRate)} />
            <Bar w={1} color={BAR} value={num(c.metrics.conversions)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Top issues ───────────────────────────────────────────────────────────────

const sevColor = { high: "#C94A1F", medium: "#B8860B", low: "#7A6F62" } as const;

function MiniDelta({ label, value, delta }: { label: string; value: string; delta: number | null }) {
  return (
    <span className={C.sub}>
      {label} <span className="text-[#1A1410] font-medium">{value}</span>
      {delta !== null && (
        <span className="ml-1" style={{ color: delta >= 0 ? GOOD : BAD }}>
          {delta >= 0 ? "+" : ""}
          {delta.toFixed(0)}%
        </span>
      )}
    </span>
  );
}

function IssueRow({ account, issues }: { account: AccountSummary; issues: Issue[] }) {
  const m = account.metrics;
  const p = account.prev;
  const ch = (a: number, b: number | undefined | null) => (b && b > 0 ? ((a - b) / b) * 100 : null);
  return (
    <div className="relative border-b border-[#EAE3D2] last:border-b-0">
      <div className="absolute left-0 top-0 bottom-0 w-1 max-h-10" style={{ background: sevColor[issues[0]?.severity ?? "medium"] }} />
      <div className="pl-4 pr-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <span className="text-[12px] font-semibold text-[#1A1410]">{account.name}</span>
            <span className="text-[11px] text-[#7A6F62] uppercase tracking-[0.14em] px-1.5 py-0.5 bg-[#F5F1E8] rounded-[3px]">
              {account.platform === "meta" ? "Meta" : "Google Ads"}
            </span>
            <div className="flex items-center gap-2 sm:gap-3 text-[11px] flex-wrap">
              <MiniDelta label="SPEND" value={moneyK(m.spend)} delta={ch(m.spend, p?.spend)} />
              <MiniDelta label="CONV" value={num(m.conversions)} delta={ch(m.conversions, p?.conversions)} />
              <MiniDelta label="ROAS" value={x(m.roas)} delta={ch(m.roas, p?.roas)} />
            </div>
          </div>
        </div>
        <ul className="space-y-1 ml-1">
          {issues.map((it) => (
            <li key={it.id} className="flex gap-2">
              <span className="text-[#A89F90] text-[12px] leading-4 shrink-0">•</span>
              <div className="text-[12px] text-[#7A6F62] leading-4">
                <span>
                  <strong className="text-[#1A1410]">{it.title}</strong>: {it.detail}
                </span>
                <div className="text-[#7A6F62] mt-0.5">
                  <strong className="text-[#1A1410]">Action:</strong> {it.action}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TopIssues({ items, title }: { items: { account: AccountSummary; issues: Issue[] }[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`${C.card} ${C.shadow} rounded-[3px]`}>
      <div className="px-4 sm:px-6 py-4 border-b border-[#EAE3D2]">
        <h3 className={C.label}>{title}</h3>
      </div>
      <div>
        {items.map((it) => (
          <IssueRow key={it.account.id} account={it.account} issues={it.issues} />
        ))}
      </div>
    </div>
  );
}

// ── Portfolio table ──────────────────────────────────────────────────────────

function PortfolioTable({ accounts }: { accounts: AccountSummary[] }) {
  const maxCtr = Math.max(...accounts.map((a) => a.metrics.ctr), 1);
  const Bar = ({ w, color }: { w: number; color: string }) => (
    <div className="w-12 sm:w-16 h-1.5 bg-[#F5F1E8] rounded-full overflow-hidden flex-shrink-0">
      <div className="h-full rounded-full" style={{ width: `${Math.max(6, Math.min(100, w * 100))}%`, background: color }} />
    </div>
  );
  const th = "text-left px-3 sm:px-4 py-2.5 text-[11px] font-semibold text-[#1A1410] uppercase tracking-[0.14em] whitespace-nowrap";
  return (
    <div className={`${C.card} ${C.shadow} rounded-[3px]`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-[#EAE3D2]">
              <th className={th}>Account</th>
              <th className={th}>Platform</th>
              <th className={th}>ROAS</th>
              <th className={th}>CTR</th>
              <th className={`${th} text-right`}>Cost</th>
              <th className={`${th} text-right`}>CPA</th>
              <th className={`${th} text-right`}>Conv</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const m = a.metrics;
              const cpaBad = m.roas < 2;
              return (
                <tr key={a.id} className="border-b border-[#EAE3D2] last:border-b-0 hover:bg-[#F5F1E8] transition-colors">
                  <td className="px-3 sm:px-4 py-3"><span className="text-[12px] font-medium text-[#1A1410] whitespace-nowrap">{a.name}</span></td>
                  <td className="px-3 sm:px-4 py-3"><PlatformBadge platform={a.platform} /></td>
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-[#1A1410] w-8">{x(m.roas)}</span>
                      <Bar w={m.roas / 7} color={perfColor(m.roas)} />
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-[#1A1410] w-8">{pct(m.ctr)}</span>
                      <Bar w={m.ctr / maxCtr} color={ctrColor(m.ctr)} />
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap"><span className="text-[12px] text-[#1A1410]">{money(m.spend)}</span></td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                    <span className="text-[12px] font-medium" style={{ color: cpaBad ? BAD : "#1A1410" }}>{money(m.cpa)}</span>
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap"><span className="text-[12px] text-[#1A1410]">{num(m.conversions)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

const RANGES = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
];

function TopBar({
  view, setView, accounts, accountId, setAccountId, days, setDays, range, refreshing, onRefresh,
}: {
  view: "account" | "portfolio";
  setView: (v: "account" | "portfolio") => void;
  accounts: AccountRef[];
  accountId: string | null;
  setAccountId: (id: string) => void;
  days: number;
  setDays: (d: number) => void;
  range: { since: string; until: string } | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const selected = accounts.find((a) => a.id === accountId);
  return (
    <div className="flex flex-col gap-3 mb-5 sm:mb-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="inline-flex border border-[#EAE3D2] bg-[#FFFCF7] w-fit rounded-[3px] overflow-hidden">
        {(["account", "portfolio"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex-none px-4 sm:px-5 py-2 text-[12px] sm:text-[13px] font-medium transition-colors whitespace-nowrap ${
              view === v ? "bg-[#1A1410] text-white" : "text-[#7A6F62] hover:text-[#1A1410] hover:bg-[#F5F1E8]"
            }`}
          >
            {v === "account" ? "Account View" : "Portfolio View"}
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
        {view === "account" && (
          <div className="relative w-fit flex items-center gap-2 pl-3 pr-9 h-9 border border-[#EAE3D2] bg-[#FFFCF7] hover:bg-[#F5F1E8] transition-colors rounded-[3px]">
            {selected && <PlatformLogo platform={selected.platform} size={16} />}
            <select
              value={accountId ?? ""}
              onChange={(e) => setAccountId(e.target.value)}
              className="appearance-none bg-transparent min-w-[160px] text-[13px] font-medium text-[#1A1410] cursor-pointer focus:outline-none"
            >
              {accounts.length === 0 && <option value="">Select Account</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.platform === "meta" ? "Meta" : "Google"}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A89F90] pointer-events-none" />
          </div>
        )}
        {selected && view === "account" && (
          <span className="text-[10px] text-[#7A6F62] font-mono self-center hidden sm:inline">ID: {selected.id.replace("act_", "")}</span>
        )}

        <div className="flex items-center gap-2 px-3 sm:px-4 h-9 border border-[#EAE3D2] bg-[#FFFCF7] rounded-[3px] w-fit">
          <Calendar className="w-4 h-4 text-[#7A6F62] shrink-0" />
          <span className="text-[12px] sm:text-[13px] text-[#1A1410] truncate">{range ? fmtRange(range.since, range.until) : "—"}</span>
        </div>

        <div className="inline-flex border border-[#EAE3D2] bg-[#FFFCF7] rounded-[3px] overflow-hidden h-9">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-2.5 text-[12px] font-medium transition-colors ${
                days === r.days ? "bg-[#1A1410] text-white" : "text-[#7A6F62] hover:text-[#1A1410] hover:bg-[#F5F1E8]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          onClick={onRefresh}
          className="p-2.5 h-9 border border-[#EAE3D2] bg-[#FFFCF7] hover:bg-[#F5F1E8] rounded-[3px] flex items-center justify-center"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 text-[#7A6F62] ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [view, setView] = useState<"account" | "portfolio">("portfolio");
  const [accounts, setAccounts] = useState<AccountRef[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [portfolio, setPortfolio] = useState<PortfolioReport | null>(null);
  const [account, setAccount] = useState<AccountReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const range = useMemo(() => {
    const until = new Date();
    const since = new Date(until);
    since.setDate(since.getDate() - (days - 1));
    const iso = (d: Date) => d.toISOString().split("T")[0];
    return { since: iso(since), until: iso(until) };
  }, [days]);
  const qs = `since=${range.since}&until=${range.until}`;

  // Load account list once.
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        const list: AccountRef[] = data.accounts ?? [];
        setAccounts(list);
        setAccountId((cur) => cur ?? (list[0]?.id ?? null));
      })
      .catch(() => {});
  }, []);

  // Portfolio fetch.
  useEffect(() => {
    if (view !== "portfolio") return;
    setRefreshing(true);
    setError(null);
    fetch(`/api/portfolio?${qs}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setPortfolio(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setRefreshing(false));
  }, [view, qs, nonce]);

  // Account fetch.
  useEffect(() => {
    if (view !== "account" || !accountId) return;
    const acc = accounts.find((a) => a.id === accountId);
    const plat = acc ? `&platform=${acc.platform}` : "";
    setRefreshing(true);
    setError(null);
    fetch(`/api/account?account_id=${encodeURIComponent(accountId)}${plat}&${qs}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setAccount(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setRefreshing(false));
  }, [view, accountId, qs, nonce, accounts]);

  const preview = (view === "portfolio" ? portfolio?.preview : account?.preview) ?? false;
  const currency = account?.account.currency ?? "USD";

  return (
    <div className="min-h-screen bg-[#F7F4ED]">
      <div className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6 w-full">
        <TopBar
          view={view}
          setView={setView}
          accounts={accounts}
          accountId={accountId}
          setAccountId={setAccountId}
          days={days}
          setDays={setDays}
          range={range}
          refreshing={refreshing}
          onRefresh={() => setNonce((n) => n + 1)}
        />

        {error && (
          <div className="px-4 py-3 rounded-[3px] border border-[#E2C9B8] bg-[#FBF1EA] text-[13px] text-[#963024] mb-4">{error}</div>
        )}

        {/* ── Portfolio View ── */}
        {view === "portfolio" && portfolio && (
          <div className="space-y-4 sm:space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <KpiCard left={{ label: "Total Spend", value: money(portfolio.totals.spend) }} right={{ label: "ROAS", value: x(portfolio.totals.roas) }} />
              <KpiCard left={{ label: "Conversions", value: num(portfolio.totals.conversions) }} right={{ label: "CPA", value: money(portfolio.totals.cpa) }} />
              <KpiCard left={{ label: "Clicks", value: num(portfolio.totals.clicks) }} right={{ label: "CTR", value: pct(portfolio.totals.ctr) }} />
            </div>
            {preview && <PreviewBanner />}
            <PortfolioTable accounts={portfolio.accounts} />
            <TopIssues items={portfolio.topIssues} title="Top Issues to Fix (3 Lowest-ROAS Accounts)" />
          </div>
        )}

        {/* ── Account View ── */}
        {view === "account" && account && (
          <div className="space-y-5 sm:space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <KpiCard
                left={{ label: "Cost", value: money(account.kpis.cost.value, currency), delta: account.kpis.cost }}
                right={{ label: "ROAS", value: x(account.kpis.roas.value), delta: account.kpis.roas }}
              />
              <KpiCard
                left={{ label: "Conversions", value: num(account.kpis.conversions.value), delta: account.kpis.conversions }}
                right={{ label: "Conv. Rate", value: pct(account.kpis.convRate.value), delta: account.kpis.convRate }}
              />
              <KpiCard
                left={{ label: "Clicks", value: num(account.kpis.clicks.value), delta: account.kpis.clicks }}
                right={{ label: "CTR", value: pct(account.kpis.ctr.value), delta: account.kpis.ctr }}
              />
            </div>
            {preview && <PreviewBanner />}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <ComboChart data={account.daily} barKey="spend" lineKey="roas" barLabel="Cost" lineLabel="ROAS" />
              <ComboChart data={account.daily} barKey="conversions" lineKey="convRate" barLabel="Conversions" lineLabel="Conv. Rate" />
              <ComboChart data={account.daily} barKey="clicks" lineKey="ctr" barLabel="Clicks" lineLabel="CTR" />
            </div>
            <ChannelTable channels={account.channels} />
            <TopIssues
              items={[{ account: { ...account.account, metrics: account.channels[0]?.metrics ?? ({} as Metrics), prev: null }, issues: account.issues }].filter((i) => i.issues.length > 0)}
              title="Top Issues to Fix"
            />
          </div>
        )}

        {!portfolio && !account && !error && <div className="py-24 text-center text-[13px] text-[#A89F90]">Loading…</div>}

        <footer className="mt-8 sm:mt-12 pt-4 sm:pt-6 border-t border-[#EAE3D2]">
          <div className="flex items-center justify-end gap-6 text-[13px] text-[#7A6F62]">
            <span>Open Ads Report</span>
            <span className="font-mono text-[11px]">API: /api/portfolio · /api/account</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
