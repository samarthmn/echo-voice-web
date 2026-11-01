import { build } from 'esbuild';
import { defined } from './assertions.ts';
/** Use the production guards inside serialized Playwright callbacks too. */
const result = await build({
  stdin: {
    contents: "import {meeting} from './web/guards.ts';globalThis.testMeeting=meeting;",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
});
export const browserGuards = defined(result.outputFiles[0]).text;
