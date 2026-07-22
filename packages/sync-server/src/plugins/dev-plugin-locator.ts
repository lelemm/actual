import path from 'path';

type DevPluginLocator = {
  port: string;
  path: string;
};
export type DevPluginLocatorInput =
  | number
  | `${number}`
  | {
      port?: unknown;
      path?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

// Keeps local dev plugin registration out of production servers.
export function assertDevPluginRegistrationAllowed() {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Dev plugins can only be registered in development mode');
  }
}

// Accepts dev-server paths while keeping manifest and entry fetches same-origin.
export function normalizeDevPluginPath(rawPath: unknown): string {
  const rawPathname =
    typeof rawPath === 'string' && rawPath !== '' ? rawPath : '/manifest.json';
  const decodedPathname = decodeDevPluginPathForValidation(rawPathname);
  const validationPathname = decodedPathname.split('\\').join('/');

  if (
    !rawPathname.startsWith('/') ||
    !validationPathname.startsWith('/') ||
    validationPathname.split('/').includes('..')
  ) {
    throw new Error('Dev plugin URL path must stay inside the origin');
  }

  return path.posix.normalize(rawPathname);
}

function decodeDevPluginPathForValidation(rawPathname: string): string {
  let decodedPathname = rawPathname;

  while (true) {
    let nextPathname: string;
    try {
      nextPathname = decodeURIComponent(decodedPathname);
    } catch {
      if (decodedPathname === rawPathname) {
        throw new Error('Dev plugin URL path must stay inside the origin');
      }
      return decodedPathname;
    }

    if (nextPathname === decodedPathname) {
      return decodedPathname;
    }
    decodedPathname = nextPathname;
  }
}

// Allows a compact dev plugin config while still rejecting invalid ports.
function normalizeDevPluginPort(rawPort: unknown): string {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Dev plugin port must be a valid TCP port');
  }

  return String(port);
}

// Normalizes supported dev plugin locator shapes into one fetch target.
export function normalizeDevPluginLocator(
  rawLocator: DevPluginLocatorInput,
): DevPluginLocator {
  if (
    typeof rawLocator === 'number' ||
    (typeof rawLocator === 'string' && isNonEmptyDigitString(rawLocator))
  ) {
    return {
      port: normalizeDevPluginPort(rawLocator),
      path: '/manifest.json',
    };
  }

  if (!isRecord(rawLocator)) {
    throw new Error('Dev plugin manifest location must be a port or object');
  }

  return {
    port: normalizeDevPluginPort(rawLocator.port),
    path: normalizeDevPluginPath(rawLocator.path),
  };
}

// Centralizes dev plugin fetch URL construction after locator validation.
export function buildDevPluginUrl(locator: DevPluginLocator): string {
  return `http://127.0.0.1:${locator.port}${locator.path}`;
}

function isNonEmptyDigitString(value: string): boolean {
  return value !== '' && Array.from(value).every(isDigit);
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}
