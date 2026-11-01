import { record } from '../web/guards.ts';
export function extensionManifest(value: unknown): { key: string; version: string } {
  const v = record(value);
  if (typeof v['key'] !== 'string' || typeof v['version'] !== 'string')
    throw new Error('Invalid extension manifest.');
  return value as { key: string; version: string };
}
import type { Server } from 'node:net';
export function serverPort(server: Pick<Server, 'address'>): number {
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The isolated test server has no TCP address.');
  return address.port;
}
