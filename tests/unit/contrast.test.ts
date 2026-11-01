import { readTokenSource, tokenSets } from '../../scripts/build-tokens.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

type Tokens = Map<string, string>;

/** Resolve a token to a #rrggbb colour, following var() references. */
function resolve(tokens: Tokens, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Circular token reference: ${name}`);
  seen.add(name);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing token: ${name}`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference?.[1]) return resolve(tokens, reference[1], seen);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) throw new Error(`${name} is not a plain colour: ${value}`);
  return hex.length === 3 ? `#${hex.replace(/./g, '$&$&')}` : `#${hex}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;
const GROUNDS = ['--color-bg', '--color-surface', '--color-surface-alt'];

/** [foreground, background, minimum ratio] for every pairing the UI uses. */
const PAIRS: [string, string, number][] = [
  ...['--color-text', '--color-text-muted', '--color-accent-text'].flatMap((text) =>
    GROUNDS.map((ground): [string, string, number] => [text, ground, TEXT]),
  ),
  ['--color-text', '--color-accent-soft', TEXT],
  ['--color-accent-text', '--color-accent-soft', TEXT],
  ['--color-on-accent', '--color-accent', TEXT],
  ['--color-on-accent', '--color-accent-hover', TEXT],
  ['--color-on-accent', '--color-accent-pressed', TEXT],
  ['--color-on-danger', '--color-danger', TEXT],
  ...['success', 'warning', 'danger', 'info'].flatMap((status) => [
    [`--color-${status}`, `--color-${status}-soft`, TEXT] as [string, string, number],
    ...GROUNDS.slice(0, 2).map((ground): [string, string, number] => [
      `--color-${status}`,
      ground,
      TEXT,
    ]),
  ]),
  ['--color-focus', '--color-bg', NON_TEXT],
  ['--color-focus', '--color-surface', NON_TEXT],
  ['--color-accent', '--color-bg', NON_TEXT],
];

const { light, dark } = tokenSets(await readTokenSource());
const themes: [string, Tokens][] = [
  ['light', light],
  ['dark', new Map([...light, ...dark])],
];

for (const [theme, tokens] of themes) {
  void test(`Organic ${theme} theme meets WCAG AA for every UI pairing`, () => {
    const failures = PAIRS.flatMap(([foreground, background, minimum]) => {
      const ratio = contrast(resolve(tokens, foreground), resolve(tokens, background));
      return ratio >= minimum
        ? []
        : [`${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`];
    });
    assert.deepEqual(failures, []);
  });
}

void test('contrast maths matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
});
