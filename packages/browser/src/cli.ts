#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { isNcrawlError } from './errors.ts';
import { createRuntime } from './index.ts';

const USAGE = `ncrawl-browser <command>

  profile create <projectId> [--name "Display name"]
  profile list
  profile delete <projectId>

  login <projectId> <url>     Open a visible browser on the project's profile so you can log in yourself.
                              The login is saved in the profile. Close the browser window (or Ctrl+C) when done.
  check <projectId> <url>     Open <url> with the project's profile and print where it landed (JSON).
                              Add --headless to run without a window.

Configuration comes from NCRAWL_* environment variables (see .env.example).`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: 'string' }, headless: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  const rt = createRuntime(loadConfig());
  const stop = async () => {
    await rt.sessions.shutdown();
  };
  process.once('SIGINT', () => void stop().then(() => process.exit(130)));
  process.once('SIGTERM', () => void stop().then(() => process.exit(143)));

  try {
    if (cmd === 'profile') {
      if (sub === 'create' && arg) return print(await rt.profiles.create(arg, values.name));
      if (sub === 'list') return print(await rt.profiles.list());
      if (sub === 'delete' && arg) {
        await rt.profiles.delete(arg);
        return print({ deleted: arg });
      }
    }

    if (cmd === 'login' && sub && arg) {
      const projectId = sub;
      if (!(await rt.profiles.exists(projectId))) await rt.profiles.create(projectId);
      const session = await rt.sessions.createSession({ kind: 'persistent', projectId, headless: false });
      const pageId = session.pages[0]?.pageId ?? (await rt.sessions.openPage(session.sessionId)).page.pageId;
      await rt.sessions.navigate(session.sessionId, pageId, { url: arg, waitUntil: 'domcontentloaded' });
      console.error(`Log in to the site in the opened window. NCrawl does not read what you type.\n` +
        `When you are done, close the browser window (or press Ctrl+C here).`);
      await waitForDisconnect(rt.sessions, session.sessionId);
      await stop();
      return print({ projectId, saved: true });
    }

    if (cmd === 'check' && sub && arg) {
      const session = await rt.sessions.createSession({ kind: 'persistent', projectId: sub, headless: values.headless ?? false });
      try {
        const { navigation } = await rt.sessions.openPage(session.sessionId, arg);
        return print(navigation);
      } finally {
        await rt.sessions.closeSession(session.sessionId);
      }
    }

    console.error(USAGE);
    return 1;
  } catch (e) {
    if (isNcrawlError(e)) {
      console.error(JSON.stringify({ error: e.toJSON() }, null, 2));
      return 2;
    }
    throw e;
  } finally {
    await stop();
  }
}

async function waitForDisconnect(sessions: ReturnType<typeof createRuntime>['sessions'], sessionId: string): Promise<void> {
  // The session flips to "disconnected" when the user closes the last browser window.
  while (sessions.getSession(sessionId).status === 'running') await sleep(500);
}

function print(value: unknown): number {
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
