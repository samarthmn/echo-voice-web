import { endpointURL } from './core';
import { readLink } from './settings';
import { jsonRequest } from './protocol';
// Echo's default bind address first, then nearby ports for a custom bind.
const DISCOVERY_CANDIDATES = [
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  ...[3001, 3002, 3003, 3004, 3005].map((port) => `http://127.0.0.1:${port}`),
];
const ECHO_NOT_FOUND = "Echo isn't running on this Mac — start it with ./scripts/start.sh";
/** The library an Echo v2 server at `origin` serves, if it answers GET /hello within 700 ms. */
export async function hello(origin: string): Promise<{ libraryId: string } | undefined> {
  try {
    const body = await jsonRequest(endpointURL(origin), '/hello', {
      signal: AbortSignal.timeout(700),
    });
    return body.service === 'echo-voice' &&
      body.protocolVersion === 2 &&
      typeof body.libraryId === 'string'
      ? { libraryId: body.libraryId }
      : undefined;
  } catch {
    return undefined; // Unreachable or not Echo: try the next candidate.
  }
}
export async function probe(origin: string): Promise<boolean> {
  return !!(await hello(origin));
}
/** Find Echo: manual address, saved endpoint, an announced Echo tab, then default ports. */
export async function discover(manual?: string): Promise<string> {
  const link = await readLink();
  const announced = (await chrome.storage.local.get('echoOrigin')).echoOrigin;
  const candidates = [
    ...new Set([
      ...(manual ? [endpointURL(manual)] : []),
      ...(link.state === 'none' ? [] : [link.endpoint]),
      ...(typeof announced === 'string' ? [announced] : []),
      ...DISCOVERY_CANDIDATES,
    ]),
  ];
  // Probe together; the earliest candidate that answers wins over faster later ones.
  const probes = candidates.map((origin) => probe(origin));
  for (let i = 0; i < candidates.length; i++) if (await probes[i]) return candidates[i];
  throw new Error(ECHO_NOT_FOUND);
}
