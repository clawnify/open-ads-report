// Credential access. In production the Clawnify integrations broker (the
// CREDENTIALS service binding) supplies tokens scoped to the org. Locally we
// fall back to .dev.vars env vars so the template runs standalone.

export interface CredentialServiceBinding {
  getToken(service: string, orgId: string): Promise<string | null>;
  listConnected(orgId: string): Promise<string[]>;
  /** Execute a Composio managed-app tool scoped to the org (e.g. Google Ads GAQL). */
  executeTool?(
    service: string,
    toolSlug: string,
    args: Record<string, unknown>,
    orgId: string,
  ): Promise<{ data: unknown; error: string | null; successful: boolean }>;
}

/** A bound Composio tool executor for one service, or null if unavailable. */
export type ToolExecutor = (toolSlug: string, args?: Record<string, unknown>) => Promise<unknown>;

export function getComposioExecutor(service: string): ToolExecutor | null {
  if (_service && _orgId && typeof _service.executeTool === "function") {
    const svc = _service;
    const org = _orgId;
    return async (toolSlug, args = {}) => {
      const r = await svc.executeTool!(service, toolSlug, args, org);
      if (!r.successful) throw new Error(r.error ?? `Composio tool ${toolSlug} failed`);
      return r.data;
    };
  }
  return null;
}

export interface GoogleAuth {
  accessToken: string;
  developerToken: string;
  /** Manager (MCC) account id used as login-customer-id, digits only. */
  loginCustomerId: string;
}

let _env: Record<string, string> = {};
let _service: CredentialServiceBinding | null = null;
let _orgId: string | null = null;
/** Cache of broker tokens resolved this request, keyed by service. */
let _cache: Record<string, string | null> = {};

export function initCredentials(opts: {
  env: Record<string, string>;
  credentialService?: CredentialServiceBinding;
  orgId?: string;
}) {
  _env = opts.env;
  _service = opts.credentialService ?? null;
  _orgId = opts.orgId ?? null;
  _cache = {};
}

async function brokerToken(service: string): Promise<string | null> {
  if (service in _cache) return _cache[service];
  let token: string | null = null;
  if (_service && _orgId) {
    try {
      token = await _service.getToken(service, _orgId);
    } catch {
      token = null;
    }
  }
  _cache[service] = token;
  return token;
}

/** True if the integrations broker has a live connection for this service. */
export async function isServiceConnected(service: string): Promise<boolean> {
  return !!(await brokerToken(service));
}

/** Whether the credentials binding supports Composio managed-tool execution. */
export function hasToolExecutor(): boolean {
  return !!_service && typeof _service.executeTool === "function";
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function getMetaToken(): Promise<string | null> {
  return (await brokerToken("metaads")) ?? _env.METAADS_BEARER_TOKEN ?? null;
}

// ── Google ─────────────────────────────────────────────────────────────────────
//
// Google needs three values. The broker may hand them back as a single JSON blob
// from getToken("googleads"); otherwise we assemble them from env vars. The
// developer token + login-customer-id can also come from env even when the broker
// supplies only the OAuth access token.

export async function getGoogleAuth(): Promise<GoogleAuth | null> {
  const raw = await brokerToken("googleads");

  let accessToken = "";
  let developerToken = _env.GOOGLEADS_DEVELOPER_TOKEN ?? "";
  let loginCustomerId = (_env.GOOGLEADS_LOGIN_CUSTOMER_ID ?? "").replace(/-/g, "");

  if (raw) {
    const blob = tryParseJson(raw);
    if (blob && typeof blob === "object") {
      accessToken = blob.accessToken ?? blob.access_token ?? "";
      developerToken = blob.developerToken ?? blob.developer_token ?? developerToken;
      loginCustomerId = String(blob.loginCustomerId ?? blob.login_customer_id ?? loginCustomerId ?? "").replace(/-/g, "");
    } else {
      // Broker returned a bare OAuth access token.
      accessToken = raw;
    }
  }
  if (!accessToken) accessToken = _env.GOOGLEADS_ACCESS_TOKEN ?? "";

  if (!accessToken || !developerToken) return null;
  return { accessToken, developerToken, loginCustomerId };
}

/** Per-platform connection diagnostics, surfaced via /api/state to explain gaps. */
export async function diagnostics() {
  const metaToken = await getMetaToken();
  const googleConnected = await isServiceConnected("googleads");
  const composio = hasToolExecutor();
  const direct = await getGoogleAuth();
  return {
    meta: { hasToken: !!metaToken },
    google: {
      connected: googleConnected || !!direct,
      // Preferred path: Composio runs the GAQL tool with its managed dev token.
      composioExecute: composio,
      // Fallback path needs our own dev token + login-customer-id.
      hasDeveloperToken: !!direct?.developerToken,
      hasLoginCustomerId: !!direct?.loginCustomerId,
      // Ready when we can actually query: Composio managed tool, or full direct creds.
      ready: (composio && googleConnected) || !!direct,
    },
  };
}

function tryParseJson(s: string): any | null {
  if (!s.trim().startsWith("{")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
