import type * as SettingsModule from '../../extension/src/settings.ts';
import type * as DomainModule from '../../web/types/domain.ts';
import assert from 'node:assert/strict';
/** Test boundaries remain unknown until their shape has been asserted. */
export function defined<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, 'Expected fixture value to be present.');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  assert.equal(typeof value, 'string', 'Expected text.');
  return value as string;
}
export function numeric(value: unknown): number {
  assert.equal(typeof value, 'number', 'Expected a number.');
  return value as number;
}
export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected an array.');
  return value as unknown[];
}
export function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
/** Fetch accepts three URL representations; tests compare their string form. */
export function fetchUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
export function form(value: unknown): FormData {
  assert.ok(value instanceof FormData);
  return value;
}
export function bytes(value: unknown): ArrayBuffer {
  assert.ok(value instanceof ArrayBuffer);
  return value;
}
/** VM bundles are compiled from this module; verify each requested runtime export. */
export function moduleExports<T extends object>(value: unknown, names: readonly (keyof T)[]): T {
  const exports = object(value);
  for (const key of names)
    assert.equal(typeof exports[String(key)], 'function', `Missing VM export ${String(key)}`);
  return exports as T;
}
export function connectedLink(
  value: SettingsModule.Link,
): Extract<SettingsModule.Link, { state: 'connected' }> {
  assert.equal(value.state, 'connected');
  return value;
}
export function waitingLink(
  value: SettingsModule.Link,
): Extract<SettingsModule.Link, { state: 'waiting' }> {
  assert.equal(value.state, 'waiting');
  return value;
}
export function linked(
  value: SettingsModule.Link,
): Exclude<SettingsModule.Link, { state: 'none' }> {
  assert.notEqual(value.state, 'none');
  if (value.state === 'none') throw new Error('Expected saved link');
  return value;
}
export function meetingRecord(value: unknown): DomainModule.Meeting & Record<string, unknown> {
  return parseMeeting(value) as DomainModule.Meeting & Record<string, unknown>;
}
import { meeting as parseMeeting } from '../../web/guards.ts';
export function floatAudio(value: unknown): Float32Array {
  assert.ok(value instanceof Float32Array);
  return value;
}
export function bufferChunk(value: unknown): Buffer {
  assert.ok(Buffer.isBuffer(value), 'Expected a binary stream chunk.');
  return value;
}
