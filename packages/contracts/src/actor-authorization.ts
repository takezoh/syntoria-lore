import type { ActorContext } from './index.js';

export type ActorAuthorizationGuard = (transaction: unknown) => Promise<void>;

const guards = new WeakMap<ActorContext, ActorAuthorizationGuard>();

export function bindActorAuthorizationGuard(
  actor: ActorContext,
  guard: ActorAuthorizationGuard,
): void {
  guards.set(actor, guard);
}

export function getActorAuthorizationGuard(
  actor: ActorContext,
): ActorAuthorizationGuard | undefined {
  return guards.get(actor);
}
