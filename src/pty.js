import { createRequire } from 'node:module';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const USER_EXEC = 0o100;

// node-pty's prebuilt spawn-helper must be executable; package managers that
// skip install scripts can leave it without the exec bit.
function ensureSpawnHelpersExecutable(packageDir) {
  const prebuilds = join(packageDir, 'prebuilds');
  let platforms;
  try {
    platforms = readdirSync(prebuilds);
  } catch {
    return;
  }
  for (const platform of platforms) {
    const helper = join(prebuilds, platform, 'spawn-helper');
    try {
      const { mode } = statSync(helper);
      if (!(mode & USER_EXEC)) chmodSync(helper, mode | USER_EXEC);
    } catch {
      // No helper for this platform, or it cannot be changed; spawn reports any real failure.
    }
  }
}

export async function loadPtySpawn() {
  const require = createRequire(import.meta.url);
  try {
    ensureSpawnHelpersExecutable(dirname(require.resolve('node-pty/package.json')));
  } catch {
    // Package layout not resolvable; importing node-pty below surfaces the error.
  }
  const nodePty = await import('node-pty');
  return (nodePty.spawn ?? nodePty.default.spawn);
}
