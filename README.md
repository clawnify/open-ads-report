# Open Ads Report

A live, cross-platform ads dashboard for **Meta Ads** and **Google Ads**. The app
owns every calculation and exposes the results as a clean JSON API — the same
surface that powers the UI is what Clawnify makes available to agents (via MCP/API)
and to Claude Code.

## Views

- **Portfolio View** — all accounts across all connected platforms in one table
  (ROAS / CTR / cost / CPA / conversions), sorted worst-to-best by ROAS, with
  aggregate KPI cards and the top issues across the three lowest-ROAS accounts.
- **Account View** — one account in depth: KPI cards with period-over-period
  deltas, three combo charts (Cost/ROAS, Conversions/Conv-rate, Clicks/CTR), a
  channel breakdown, and that account's top issues.

When no ad platform is connected the dashboard renders **sample/preview data** so
it looks alive inside the Clawnify iframe.

## JSON API

All endpoints accept `since` / `until` (`YYYY-MM-DD`) or `days` (defaults to 30).
Period-over-period deltas use the equal-length window immediately before `since`.

| Endpoint | Returns |
|----------|---------|
| `GET /api/state` | Connected platforms + whether preview mode is active |
| `GET /api/accounts` | Account list across connected platforms (for the picker) |
| `GET /api/portfolio?since=&until=` | `PortfolioReport`: totals, per-account rows, top issues |
| `GET /api/account?platform=&account_id=&since=&until=` | `AccountReport`: KPIs+deltas, daily series, channel, issues |

Shapes live in [`src/server/providers/types.ts`](src/server/providers/types.ts).
All metric math (ROAS, CPA, CTR, conversion rate, deltas, issue derivation) is in
[`src/server/metrics.ts`](src/server/metrics.ts) so Meta and Google numbers are
computed identically.

## Credentials

In production the **Clawnify integrations broker** supplies tokens via the
`CREDENTIALS` service binding (`metaads`, `googleads`). For local `pnpm dev`, copy
`.dev.vars.example` → `.dev.vars`:

- **Meta:** `METAADS_BEARER_TOKEN` (scope: `ads_read`)
- **Google:** `GOOGLEADS_ACCESS_TOKEN` + `GOOGLEADS_DEVELOPER_TOKEN` +
  `GOOGLEADS_LOGIN_CUSTOMER_ID` (the broker may instead return all three as a JSON
  blob from `getToken("googleads")`)
- Optional: `GOOGLEADS_API_VERSION` (default `v21`) — bump if Google has retired
  that API version.

## Develop & deploy

```bash
pnpm install
pnpm dev        # vite (UI) + wrangler (API) together
pnpm build      # vite build → dist/
npx clawnify deploy
```

## Roadmap (Phase 2)

A report renderer: agents emit a structured `<report>` document with `<analytics>`
(KPI cards + chart data) and `<actions>` (issue cards + decision tables); the app
parses the tags into the same component kit and exports leadership-ready PDFs, with
a gallery of report recipes (Account Audit, Search Terms, Creative Fatigue, …).
