import { Hono } from "hono";
import type { Bindings } from "./env";
import api from "./routes";

// Credentials are resolved per-request by @clawnify/connections straight off
// `env` (the CREDENTIALS broker binding + injected secrets), so there's no
// credential bootstrapping middleware to run here anymore.
const app = new Hono<{ Bindings: Bindings }>();

app.route("/", api);

export default app;
