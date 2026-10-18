export interface CloudOAuthBootstrapDependencies {
  getAccessToken?: () => Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
  pause?: (milliseconds: number) => Promise<void>;
}

export function runCloudOAuthBootstrap(
  action: string,
  env?: Record<string, string | undefined>,
  dependencies?: CloudOAuthBootstrapDependencies,
): Promise<{ status: 'completed'; action: string }>;
