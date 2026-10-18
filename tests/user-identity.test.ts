import {
  encodePortableBundleV1,
  decodePortableBundleV1,
} from '../packages/governance/src/user-identity-v1.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  actorKindSchema,
  encodeIdentityProvenanceV1,
  decodeIdentityProvenanceV1,
} from '@memory/contracts';
import { CursorCodec } from '@memory/domain';

describe('user identity with fixed v1 formats', () => {
  it('accepts the current actor enum and rejects the previous public name', () => {
    expect(actorKindSchema.parse('user')).toBe('user');
    expect(actorKindSchema.safeParse('owner').success).toBe(false);
  });
  it('maps only defined provenance paths and preserves arbitrary caller objects', () => {
    const context = {
      actor_kind: 'user',
      authority: 'user_assertion',
      nested: { confirmation: 'user_statement' },
    };
    const metadata = { authority: 'user_decision' };
    const current = {
      confirmation: 'user_statement',
      operations: [{ memory: { context, metadata } }],
      tables: {
        memories: [{ actor_kind: 'user', authority: 'user_assertion', context, metadata }],
      },
    };
    const fixed = {
      confirmation: 'owner_statement',
      operations: [{ memory: { context, metadata } }],
      tables: {
        memories: [{ actor_kind: 'owner', authority: 'owner_assertion', context, metadata }],
      },
    };
    expect(encodeIdentityProvenanceV1(current)).toEqual(fixed);
    expect(decodeIdentityProvenanceV1(fixed)).toEqual(current);
    expect(current.confirmation).toBe('user_statement');
  });
  it('reads an independently signed v1 cursor without changing the user identity', () => {
    const user = '11111111-1111-4111-8111-111111111111',
      principal = '22222222-2222-4222-8222-222222222222',
      scope = '33333333-3333-4333-8333-333333333333';
    const key = Buffer.alloc(32, 4);
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        kid: 'fixture',
        owner: user,
        principal,
        scopes: [scope],
        offsets: { [scope]: '5' },
        auth_epochs: { [scope]: 1 },
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const token = `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    expect(
      new CursorCodec('fixture', new Map([['fixture', key]])).decode(token, {
        user,
        principal,
        scopes: [scope],
      }).user,
    ).toBe(user);
  });
});

it('keeps portable payload v1 identity keys and rejects a current-model alias', () => {
  const context = { owner_id: 'literal context', actor_kind: 'user' };
  const current = {
    origin: { user_id: 'person' },
    tables: {
      memories: [{ user_id: 'person', actor_kind: 'user', authority: 'user_assertion', context }],
    },
  };
  const wire = {
    origin: { owner_id: 'person' },
    tables: {
      memories: [
        { owner_id: 'person', actor_kind: 'owner', authority: 'owner_assertion', context },
      ],
    },
  };
  expect(encodePortableBundleV1(current)).toEqual(wire);
  expect(decodePortableBundleV1(wire)).toEqual(current);
  expect(decodePortableBundleV1(current)).toBeUndefined();
});

it('keeps original user provenance keys inside fixed portable version 1 rows', () => {
  const current = {
    tables: {
      memories: [
        {
          import_provenance: {
            origin_user_id: 'person',
            origin_actor_kind: 'user',
            origin_authority: 'user_assertion',
          },
        },
      ],
    },
  };
  const fixed = {
    tables: {
      memories: [
        {
          import_provenance: {
            origin_owner_id: 'person',
            origin_actor_kind: 'owner',
            origin_authority: 'owner_assertion',
          },
        },
      ],
    },
  };
  expect(encodeIdentityProvenanceV1(current)).toEqual(fixed);
  expect(decodeIdentityProvenanceV1(fixed)).toEqual(current);
});
