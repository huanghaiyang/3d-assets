type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

function paint(level: Level, text: string): string {
  return `${LEVEL_COLORS[level]}${text}${RESET}`;
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${paint(level, stamp)} ${paint(level, level.toUpperCase().padEnd(5))} ${paint(level, `[${scope}]`)} ${message}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) fn(line);
  else fn(line, extra);
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => {
      if (process.env.H3D_DEBUG) write('debug', scope, m, e);
    },
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
