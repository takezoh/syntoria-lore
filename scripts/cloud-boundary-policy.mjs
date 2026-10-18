export function verifyCloudBoundaryReadbacks(config, readbacks) {
  const failures = [];
  const checks = [];
  const boundary = config.gcsBoundary;

  validateConfiguredServiceAccountRoles(
    readbacks.projectPolicy,
    config.serviceAccountProjectRoles,
    config.serviceAccounts,
    'project IAM policy',
    failures,
  );
  validateProjectRoleMembers(
    readbacks.projectPolicy,
    config.serviceAccountProjectRoles,
    config.serviceAccounts,
    failures,
  );
  checks.push('all eight declared service accounts have only their direct project roles');

  validateSecretPolicies(config, readbacks.secretPolicies, failures);
  checks.push('all thirteen declared Secret Manager policies have exact service-account accessors');

  validateCustomRoles(boundary.customRoles, readbacks.customRoles, failures);
  checks.push('all four GCS custom roles are active with exact permission sets');

  validateBucketBindings(
    readbacks.ledgerPolicy,
    [...boundary.bucketBindings.ledger, ...boundary.preservedBucketBindings],
    'ledger bucket IAM policy',
    failures,
  );
  checks.push('ledger bindings have exact runtime members and exact HEAD/node conditions');

  validateBucketBindings(
    readbacks.artifactPolicy,
    [...boundary.bucketBindings.artifacts, ...boundary.preservedBucketBindings],
    'artifact bucket IAM policy',
    failures,
  );
  checks.push('artifact bindings have exact runtime members and no extra runtime grants');

  validateArtifactBucket(readbacks.artifactBucket, boundary, failures);
  checks.push('artifact bucket has versioning off and zero soft-delete retention');

  validateResourcePolicies(config, readbacks.resourcePolicies, failures);
  checks.push('queue, registry, source bucket, and task service-account grants match the contract');

  validateServiceAccountPolicies(config, readbacks.serviceAccountPolicies, failures);
  checks.push('all eight service-account resource policies have exact declared members');

  validateWorkerInvokers(readbacks.workerPolicy, config, failures);
  checks.push('private worker invoker membership is exact and excludes public principals');

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    checks,
    failures,
  };
}

function validateConfiguredServiceAccountRoles(
  policy,
  expectedRolesByAccount,
  serviceAccounts,
  label,
  failures,
  { rejectUnknownServiceAccounts = false, allowEmptyBindings = false } = {},
) {
  const bindings = requireBindings(policy, label, failures, { allowEmptyBindings });
  if (bindings === null) return;
  validateNoPublicBindings(policy, label, failures, { allowEmptyBindings });

  const accountKeys = Object.keys(serviceAccounts);
  if (!sameArray(Object.keys(expectedRolesByAccount), accountKeys)) {
    failures.push(
      `${label}: service-account role contract does not cover exactly the declared accounts`,
    );
  }

  const declaredPrincipals = new Set(
    accountKeys.map((key) => serviceAccount(serviceAccounts[key])),
  );
  for (const [accountKey, email] of Object.entries(serviceAccounts)) {
    const principal = serviceAccount(email);
    const actualBindings = bindings.filter((binding) => binding.members?.includes(principal));
    const actualRoles = actualBindings.map((binding) => binding.role);
    const expectedRoles = expectedRolesByAccount[accountKey];
    if (expectedRoles === undefined) {
      failures.push(`${label}: ${accountKey} has no declared role set`);
      continue;
    }
    if (!sameArray(actualRoles, expectedRoles)) {
      failures.push(
        `${label}: ${accountKey} roles ${JSON.stringify(sortedUnique(actualRoles))} do not match ${JSON.stringify(sortedUnique(expectedRoles))}`,
      );
    }
    for (const binding of actualBindings) {
      if (binding.condition !== undefined && binding.condition !== null) {
        failures.push(`${label}: ${accountKey} has an unexpected condition on ${binding.role}`);
      }
    }
  }

  if (rejectUnknownServiceAccounts) {
    validateNoUndeclaredServiceAccounts(bindings, declaredPrincipals, label, failures);
  }
}

function validateSecretPolicies(config, secretPolicies, failures) {
  if (!isRecord(secretPolicies)) {
    failures.push('Secret Manager readback is not an object keyed by secret name');
    return;
  }

  const expectedSecretNames = Object.keys(config.secretAccessors).sort();
  if (!sameArray(Object.keys(secretPolicies), expectedSecretNames)) {
    failures.push(
      `Secret Manager readback secret names ${JSON.stringify(Object.keys(secretPolicies).sort())} do not match the declared set`,
    );
  }

  const actualServiceAccountAccessors = Object.fromEntries(
    Object.entries(config.principals).map(([accountKey, principal]) => [
      accountKey,
      (principal.secrets ?? []).map((versionedName) => versionedName.split(':')[0]).sort(),
    ]),
  );
  for (const accountKey of Object.keys(config.serviceAccounts)) {
    if (actualServiceAccountAccessors[accountKey] === undefined) {
      failures.push(`secret contract has no principal record for ${accountKey}`);
    }
    if (config.principals[accountKey] === undefined) {
      failures.push(`principal contract is missing ${accountKey}`);
    }
  }

  const principalSecretNames = sortedUnique(
    Object.values(config.principals).flatMap((principal) =>
      (principal.secrets ?? []).map((versionedName) => versionedName.split(':')[0]),
    ),
  );
  for (const secretName of principalSecretNames) {
    if (!expectedSecretNames.includes(secretName)) {
      failures.push(
        `principal secret declaration ${secretName} is missing from the secret accessor contract`,
      );
    }
  }

  for (const [secretName, accountKeys] of Object.entries(config.secretAccessors)) {
    const expectedAccountKeys = Object.keys(config.serviceAccounts).filter((accountKey) =>
      (actualServiceAccountAccessors[accountKey] ?? []).includes(secretName),
    );
    if (!sameArray(accountKeys, expectedAccountKeys)) {
      failures.push(
        `${secretName}: accessor contract does not match the principal secret declarations`,
      );
    }

    const expectedRolesByAccount = Object.fromEntries(
      Object.keys(config.serviceAccounts).map((accountKey) => [
        accountKey,
        accountKeys.includes(accountKey) ? ['roles/secretmanager.secretAccessor'] : [],
      ]),
    );
    validateConfiguredServiceAccountRoles(
      secretPolicies[secretName],
      expectedRolesByAccount,
      config.serviceAccounts,
      `secret ${secretName} IAM policy`,
      failures,
      { rejectUnknownServiceAccounts: true, allowEmptyBindings: true },
    );

    const bindings = requireBindings(
      secretPolicies[secretName],
      `secret ${secretName} IAM policy`,
      failures,
      { allowEmptyBindings: true },
    );
    if (bindings === null) continue;
    const accessorBindings = bindings.filter(
      (binding) => binding.role === 'roles/secretmanager.secretAccessor',
    );
    const expectedMembers = accountKeys.map((accountKey) =>
      serviceAccount(config.serviceAccounts[accountKey]),
    );
    const actualMembers = accessorBindings.flatMap((binding) => binding.members ?? []);
    if (!sameArray(actualMembers, expectedMembers)) {
      failures.push(
        `secret ${secretName} IAM policy: Secret Accessor members ${JSON.stringify(sortedUnique(actualMembers))} do not match ${JSON.stringify(sortedUnique(expectedMembers))}`,
      );
    }
    if (
      accessorBindings.some(
        (binding) => binding.condition !== undefined && binding.condition !== null,
      )
    ) {
      failures.push(
        `secret ${secretName} IAM policy: Secret Accessor binding has an unexpected condition`,
      );
    }

    const expectedBindings =
      expectedMembers.length === 0
        ? []
        : [
            {
              role: 'roles/secretmanager.secretAccessor',
              members: expectedMembers,
            },
          ];
    validateBindingList(bindings, expectedBindings, `secret ${secretName} IAM policy`, failures);
  }
}

function validateServiceAccountPolicies(config, serviceAccountPolicies, failures) {
  if (!isRecord(serviceAccountPolicies)) {
    failures.push(
      'service-account IAM readback is not an object keyed by target service-account email',
    );
    return;
  }

  const expectedTargetKeys = Object.keys(config.serviceAccounts).sort();
  const actualTargetKeys = Object.keys(serviceAccountPolicies).sort();
  if (
    !sameArray(
      actualTargetKeys,
      expectedTargetKeys.map((key) => config.serviceAccounts[key]),
    )
  ) {
    failures.push(
      'service-account IAM readback targets do not match the declared service accounts',
    );
  }

  if (!sameArray(Object.keys(config.serviceAccountPolicyBindings), expectedTargetKeys)) {
    failures.push('service-account policy contract does not cover exactly the declared accounts');
  }

  for (const [targetKey, targetEmail] of Object.entries(config.serviceAccounts)) {
    const expectedBindings = config.serviceAccountPolicyBindings[targetKey];
    if (!Array.isArray(expectedBindings)) {
      failures.push(`service-account policy contract is missing ${targetKey}`);
      continue;
    }

    const expectedBindingsForTarget = [];
    const expectedRolesByAccount = Object.fromEntries(
      Object.keys(config.serviceAccounts).map((accountKey) => [accountKey, []]),
    );
    for (const binding of expectedBindings) {
      const members = [];
      for (const accountKey of binding.members) {
        const memberEmail = config.serviceAccounts[accountKey];
        if (memberEmail === undefined) {
          failures.push(
            `service-account policy ${targetKey} references undeclared member ${accountKey}`,
          );
          continue;
        }
        members.push(serviceAccount(memberEmail));
        expectedRolesByAccount[accountKey].push(binding.role);
      }
      expectedBindingsForTarget.push({ role: binding.role, members: sortedUnique(members) });
    }

    const label = `service account policy ${targetEmail}`;
    validateConfiguredServiceAccountRoles(
      serviceAccountPolicies[targetEmail],
      expectedRolesByAccount,
      config.serviceAccounts,
      label,
      failures,
      { rejectUnknownServiceAccounts: true, allowEmptyBindings: true },
    );
    const actualBindings = requireBindings(serviceAccountPolicies[targetEmail], label, failures, {
      allowEmptyBindings: true,
    });
    if (actualBindings === null) continue;
    validateNoPublicBindings(serviceAccountPolicies[targetEmail], label, failures, {
      allowEmptyBindings: true,
    });
    validateBindingList(actualBindings, expectedBindingsForTarget, label, failures);
  }
}

function validateResourcePolicies(config, resourcePolicies, failures) {
  if (!isRecord(resourcePolicies)) {
    failures.push('resource IAM readback is not an object keyed by resource scope');
    return;
  }

  const expectedResourceNames = Object.keys(config.resourceServiceAccountRoles).sort();
  if (!sameArray(Object.keys(resourcePolicies), expectedResourceNames)) {
    failures.push(
      `resource IAM readback scopes ${JSON.stringify(Object.keys(resourcePolicies).sort())} do not match the declared scopes`,
    );
  }

  if (!sameArray(Object.keys(config.preservedResourceBindings), ['build-source'])) {
    failures.push(
      'resource IAM contract may preserve non-service-account bindings only for build-source',
    );
  }

  for (const [resourceName, expectedRolesByAccount] of Object.entries(
    config.resourceServiceAccountRoles,
  )) {
    validateConfiguredServiceAccountRoles(
      resourcePolicies[resourceName],
      expectedRolesByAccount,
      config.serviceAccounts,
      `${resourceName} IAM policy`,
      failures,
      { rejectUnknownServiceAccounts: true },
    );

    const expectedBindings = serviceAccountRoleBindings(
      expectedRolesByAccount,
      config.serviceAccounts,
    );
    const preservedBindings = config.preservedResourceBindings[resourceName] ?? [];
    validateExactPolicyBindings(
      resourcePolicies[resourceName],
      [...expectedBindings, ...preservedBindings],
      `${resourceName} IAM policy`,
      failures,
    );
  }
}

function validateProjectRoleMembers(policy, expectedRolesByAccount, serviceAccounts, failures) {
  const bindings = requireBindings(policy, 'project IAM policy', failures);
  if (bindings === null) return;

  const expectedMembersByRole = new Map();
  for (const [accountKey, roles] of Object.entries(expectedRolesByAccount)) {
    const email = serviceAccounts[accountKey];
    if (email === undefined) continue;
    for (const role of roles) {
      const members = expectedMembersByRole.get(role) ?? [];
      members.push(serviceAccount(email));
      expectedMembersByRole.set(role, members);
    }
  }

  const controlledRoles = new Set(expectedMembersByRole.keys());
  const expectedBindings = [...expectedMembersByRole].map(([role, members]) => ({ role, members }));
  const actualBindings = bindings.filter((binding) => controlledRoles.has(binding.role));
  validateBindingList(
    actualBindings,
    expectedBindings,
    'project IAM policy controlled roles',
    failures,
  );
}

function serviceAccountRoleBindings(expectedRolesByAccount, serviceAccounts) {
  const membersByRole = new Map();
  for (const [accountKey, roles] of Object.entries(expectedRolesByAccount)) {
    const email = serviceAccounts[accountKey];
    if (email === undefined) continue;
    for (const role of roles) {
      const members = membersByRole.get(role) ?? [];
      members.push(serviceAccount(email));
      membersByRole.set(role, members);
    }
  }
  return [...membersByRole].map(([role, members]) => ({ role, members }));
}

function validateExactPolicyBindings(policy, expectedBindings, label, failures) {
  const actualBindings = requireBindings(policy, label, failures);
  if (actualBindings === null) return;
  validateBindingList(actualBindings, expectedBindings, label, failures);
}

function validateBindingList(actualBindings, expectedBindings, label, failures) {
  const normalize = (binding) =>
    JSON.stringify(
      canonicalize({
        role: binding.role ?? null,
        members: Array.isArray(binding.members) ? [...binding.members].sort() : null,
        condition: binding.condition ?? null,
      }),
    );
  const actual = actualBindings.map(normalize).sort();
  const expected = expectedBindings.map(normalize).sort();
  if (!sameList(actual, expected)) {
    failures.push(
      `${label}: bindings do not match the exact declared role, member, and condition sets`,
    );
  }
}

function validateCustomRoles(expectedRoles, readbacks, failures) {
  if (!isRecord(readbacks)) {
    failures.push('custom role readback is not an object');
    return;
  }

  const expectedRoleIds = Object.values(expectedRoles)
    .map((role) => role.name.split('/').at(-1))
    .filter((roleId) => roleId !== undefined)
    .sort();
  if (!sameArray(Object.keys(readbacks), expectedRoleIds)) {
    failures.push(
      `custom role IDs ${JSON.stringify(Object.keys(readbacks).sort())} do not match ${JSON.stringify(expectedRoleIds)}`,
    );
  }

  for (const expected of Object.values(expectedRoles)) {
    const roleId = expected.name.split('/').at(-1);
    const actual = readbacks[roleId];
    if (!isRecord(actual)) {
      failures.push(`custom role ${roleId} is missing from the readback`);
      continue;
    }
    if (actual.name !== expected.name)
      failures.push(`custom role ${roleId} has an unexpected name`);
    if (actual.title !== expected.title)
      failures.push(`custom role ${roleId} has an unexpected title`);
    if (actual.stage !== expected.stage)
      failures.push(`custom role ${roleId} is not at stage ${expected.stage}`);
    if (actual.deleted === true) failures.push(`custom role ${roleId} is deleted`);
    if (actual.disabled === true) failures.push(`custom role ${roleId} is disabled`);
    if (!Array.isArray(actual.includedPermissions)) {
      failures.push(`custom role ${roleId} has no permission list`);
      continue;
    }
    if (!sameArray(actual.includedPermissions, expected.permissions)) {
      failures.push(
        `custom role ${roleId} permissions ${JSON.stringify(sortedUnique(actual.includedPermissions))} do not match ${JSON.stringify(sortedUnique(expected.permissions))}`,
      );
    }
    if (new Set(actual.includedPermissions).size !== actual.includedPermissions.length) {
      failures.push(`custom role ${roleId} contains duplicate permissions`);
    }
  }
}

function validateBucketBindings(policy, expectedBindings, label, failures) {
  const bindings = requireBindings(policy, label, failures);
  if (bindings === null) return;
  validateNoPublicBindings(policy, label, failures);
  validateBindingList(bindings, expectedBindings, label, failures);
}

function validateArtifactBucket(bucket, boundary, failures) {
  if (!isRecord(bucket)) {
    failures.push('artifact bucket readback is not an object');
    return;
  }
  if (bucket.name !== boundary.artifactBucket) {
    failures.push(`artifact bucket readback name does not match ${boundary.artifactBucket}`);
  }

  const versioningEnabled = readVersioningEnabled(bucket, failures);
  if (versioningEnabled !== boundary.artifactBucketSettings.versioningEnabled) {
    failures.push('artifact bucket versioning is enabled or could not be confirmed disabled');
  }

  const retention = bucket.soft_delete_policy?.retentionDurationSeconds;
  if (
    retention === undefined ||
    retention === null ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(retention))
  ) {
    failures.push('artifact bucket soft-delete retention is missing or invalid');
  } else if (Number(retention) !== boundary.artifactBucketSettings.softDeleteRetentionSeconds) {
    failures.push(
      `artifact bucket soft-delete retention is ${retention} seconds; expected ${boundary.artifactBucketSettings.softDeleteRetentionSeconds}`,
    );
  }

  if (boundary.artifactBucketSettings.uniformBucketLevelAccess === true) {
    if (bucket.uniform_bucket_level_access !== true) {
      failures.push('artifact bucket uniform bucket-level access is not enabled');
    }
  }
  if (boundary.artifactBucketSettings.publicAccessPrevention === 'enforced') {
    if (bucket.public_access_prevention !== 'enforced') {
      failures.push('artifact bucket public access prevention is not enforced');
    }
  }
}

function readVersioningEnabled(bucket, failures) {
  if (bucket.versioning === undefined) return false;
  if (!isRecord(bucket.versioning) || typeof bucket.versioning.enabled !== 'boolean') {
    failures.push('artifact bucket versioning state is malformed');
    return null;
  }
  return bucket.versioning.enabled;
}

function validateWorkerInvokers(policy, config, failures) {
  const expectedRolesByAccount = Object.fromEntries(
    Object.keys(config.serviceAccounts).map((accountKey) => [accountKey, []]),
  );
  for (const email of config.workerService.expectedServiceAccountInvokers) {
    const entry = Object.entries(config.serviceAccounts).find(
      ([, accountEmail]) => accountEmail === email,
    );
    if (entry === undefined) {
      failures.push(`worker invoker contract references undeclared service account ${email}`);
      continue;
    }
    expectedRolesByAccount[entry[0]] = ['roles/run.invoker'];
  }

  validateConfiguredServiceAccountRoles(
    policy,
    expectedRolesByAccount,
    config.serviceAccounts,
    'worker service IAM policy',
    failures,
    { rejectUnknownServiceAccounts: true },
  );
  validateExactPolicyBindings(
    policy,
    [
      {
        role: 'roles/run.invoker',
        members: config.workerService.expectedServiceAccountInvokers.map(serviceAccount),
      },
    ],
    'worker service IAM policy',
    failures,
  );
}

function validateNoUndeclaredServiceAccounts(bindings, declaredPrincipals, label, failures) {
  for (const binding of bindings) {
    for (const member of binding.members ?? []) {
      if (member.startsWith('serviceAccount:') && !declaredPrincipals.has(member)) {
        failures.push(`${label}: undeclared service account ${member} is bound to ${binding.role}`);
      }
    }
  }
}

function validateNoPublicBindings(policy, label, failures, { allowEmptyBindings = false } = {}) {
  const bindings = requireBindings(policy, label, failures, { allowEmptyBindings });
  if (bindings === null) return;
  for (const binding of bindings) {
    for (const member of binding.members ?? []) {
      if (member === 'allUsers' || member === 'allAuthenticatedUsers') {
        failures.push(`${label}: public principal ${member} is bound to ${binding.role}`);
      }
    }
  }
}

function requireBindings(policy, label, failures, { allowEmptyBindings = false } = {}) {
  if (!isRecord(policy)) {
    failures.push(`${label} has no bindings array`);
    return null;
  }
  if (policy.bindings === undefined && allowEmptyBindings) return [];
  if (!Array.isArray(policy.bindings)) {
    failures.push(`${label} has no bindings array`);
    return null;
  }
  return policy.bindings;
}

function serviceAccount(email) {
  return `serviceAccount:${email}`;
}

function sameArray(left, right) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function sameList(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
