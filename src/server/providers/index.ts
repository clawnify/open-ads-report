// Provider registry. Resolves whichever ad platforms have credentials this
// request and gives the routes a single place to fan out across them.

import type { AdProvider, Platform } from "./types";
import { MetaProvider } from "./meta";
import { GoogleProvider } from "./google";

export async function connectedProviders(env: Record<string, string>): Promise<AdProvider[]> {
  const providers = await Promise.all([MetaProvider.create(), GoogleProvider.create(env)]);
  return providers.filter((p): p is NonNullable<typeof p> => p !== null && p.isConnected());
}

export async function getProvider(env: Record<string, string>, platform: Platform): Promise<AdProvider | null> {
  const all = await connectedProviders(env);
  return all.find((p) => p.id === platform) ?? null;
}
