import { redactValue } from './redaction.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

/** One JSON object per line on stderr (stdout stays free for CLI output). All fields pass through redaction. */
export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
  sink: LogSink = (line) => process.stderr.write(line + '\n'),
): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redactValue({ ...bindings, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...record }));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger(level, { ...bindings, ...b }, sink),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
