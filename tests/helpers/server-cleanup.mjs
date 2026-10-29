import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

async function waitForExit(exit, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Native encrypted helper cleanup may need two bounded DiskImages calls. Give
// it time to finish, and never delete its files after a forced termination.
export async function stopTestServer(child, { graceMs = 120000, killMs = 5000 } = {}) {
  if (!child.pid || child.exitCode !== null) return;
  if (child.signalCode !== null)
    throw new Error('The test server was terminated abruptly; its data was preserved.');
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  if (await waitForExit(exit, graceMs)) return;
  child.kill('SIGKILL');
  const stopped = await waitForExit(exit, killMs);
  throw new Error(
    `The test server ${stopped ? 'required forced termination' : 'did not exit'}; its data was preserved for owned cleanup.`,
  );
}

// Refuse to recurse through a mounted helper volume even if server shutdown
// reported success. A mount must be detached by its owner before deletion.
export async function assertNoMountedDirectory(
  directory,
  { inspect = lstat, entries = readdir } = {},
) {
  const root = path.resolve(directory);
  const parent = await inspect(path.dirname(root));
  async function inspectTree(location) {
    const metadata = await inspect(location);
    if (metadata.isSymbolicLink()) return;
    if (metadata.dev !== parent.dev)
      throw new Error(`Test data contains a mounted filesystem; preserved ${root}.`);
    if (metadata.isDirectory()) {
      for (const name of await entries(location)) await inspectTree(path.join(location, name));
    }
  }
  await inspectTree(root);
}

export async function removeTestDirectory(directory) {
  const relative = path.relative(path.resolve('tmp'), path.resolve(directory));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Test cleanup is restricted to an owned directory inside project/tmp.');
  }
  await assertNoMountedDirectory(directory);
  await rm(directory, { recursive: true, force: true });
}
