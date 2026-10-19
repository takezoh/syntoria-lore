export interface CloudDeploymentConfig {
  project: string;
  projectNumber: string;
  region: string;
  productDisplayName: string;
  taskQueue: {
    name: string;
    invokerServiceAccount: string;
    schedulerServiceAccount: string;
    schedulerJob: string;
  };
  vertex: {
    location: string;
    extractionModel: string;
    embeddingModel: string;
    embeddingDimension: string;
  };
  [key: string]: unknown;
}

export function readCloudDeploymentConfig(): Promise<CloudDeploymentConfig>;
