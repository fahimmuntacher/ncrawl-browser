import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Starts the built Next.js test app with `next start` on a free loopback port. Credentials: demo / demo. */

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export interface NextTestApp {
  url: string;
  stats(): Promise<{ logins: number; mutations: number }>;
  close(): Promise<void>;
}

export async function startNextApp(): Promise<NextTestApp> {
  if (!existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) throw new Error('Next.js test app is not built. Run: npm run test-apps:build');
  const port = await freePort();
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited (${child.exitCode}):\n${output}`);
    try {
      if ((await fetch(`${url}/api/stats`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`next start did not become ready:\n${output}`);
    }
    await sleep(200);
  }

  return {
    url,
    stats: async () => (await fetch(`${url}/api/stats`)).json() as Promise<{ logins: number; mutations: number }>,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5_000).then(() => child.kill('SIGKILL'))]);
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
