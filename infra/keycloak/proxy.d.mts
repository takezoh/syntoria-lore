import type { Server } from 'node:http';

export function isPublicIdentityPathAllowed(
  pathname: string,
  method: string,
  realm: string,
): boolean;
export function createIdentityProxy(options: {
  publicUrl: string;
  backendUrl?: string;
  realm: string;
}): Server;
