export function renderCloudBuild(config: {
  readonly project: string;
  readonly artifactRegistry: string;
  readonly imageName: string;
  readonly build: { readonly serviceAccount: string };
}): string;
