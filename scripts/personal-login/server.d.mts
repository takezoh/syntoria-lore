import type { Server } from 'node:http';
export interface Config {
  issuer: string;
  clientId: string;
  subject: string;
}
export interface Exchange {
  code: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
}
export interface Oidc {
  authorizationEndpoint: string;
  logoutEndpoint: string;
  exchange(input: Exchange): Promise<{ expiresAt: number }>;
}
export function startPersonalLogin(options: {
  config: Config;
  oidcFactory: (config: Config) => Promise<Oidc>;
  port?: number;
  now?: () => number;
  attemptMs?: number;
}): Promise<{ server: Server; url: string; close(): Promise<void> }>;
