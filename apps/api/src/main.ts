import { createServer } from 'node:http';
import { createApiApp } from './app.js';
import { ConfigError, loadConfig, type ApiConfig } from './config.js';

let config: ApiConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : 'Invalid configuration');
  process.exit(1);
}

const log = (event: Readonly<Record<string, unknown>>) => console.log(JSON.stringify(event));
const app = createApiApp(config, { log });
const server = createServer(app.listener);

server.listen(config.port, '0.0.0.0', () => {
  log({
    event: 'api.started',
    port: config.port,
    embedding_provider: config.embedding.provider,
    cursor_key_id: config.cursorKeyId,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void app.close().finally(() => process.exit(0));
    });
  });
}
