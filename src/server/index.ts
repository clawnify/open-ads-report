import { Hono } from "hono";
import { initCredentials } from "./credentials";
import type { CredentialServiceBinding } from "./credentials";
import api from "./routes";

type Env = {
  Bindings: {
    CREDENTIALS?: CredentialServiceBinding;
    CLAWNIFY_ORG_ID?: string;
    // Local dev fallbacks (production uses the CREDENTIALS broker):
    METAADS_BEARER_TOKEN?: string;
    GOOGLEADS_ACCESS_TOKEN?: string;
    GOOGLEADS_DEVELOPER_TOKEN?: string;
    GOOGLEADS_LOGIN_CUSTOMER_ID?: string;
    GOOGLEADS_API_VERSION?: string;
    OPENROUTER_API_KEY?: string;
  };
};

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  initCredentials({
    env: c.env as unknown as Record<string, string>,
    credentialService: c.env.CREDENTIALS,
    orgId: c.env.CLAWNIFY_ORG_ID,
  });
  await next();
});

app.route("/", api);

export default app;
