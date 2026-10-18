export function parsePort(value: string | undefined, variable: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${variable} must be an integer between 1 and 65535`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variable} must be an integer between 1 and 65535`);
  }

  return port;
}
