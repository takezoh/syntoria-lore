import type { Authenticator } from '@memory/auth';
import { CoreError, type ActorContext } from '@memory/contracts';
import type { ConnectionRef } from '@memory/domain';

/** The Gate connection an actor authenticated with, whose allowance it may change. */
export function connectionOf(auth: Authenticator, actor: ActorContext): ConnectionRef {
  const identity = auth.gateIdentity(actor);
  if (identity === undefined) {
    throw new CoreError(400, 'connection_required', 'Only an AI connection has an allowance');
  }
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    connectionId: identity.connectionId,
    clientId: identity.clientId,
  };
}
