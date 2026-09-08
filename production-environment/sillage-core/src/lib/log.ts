const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level as LogLevel] ?? LEVELS.info;
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
    /** Progress line that overwrites itself when attached to a TTY. */
    progress: (m: string) => {
      if (LEVELS.info < threshold) return;
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K  ${m}`);
      else emit("debug", scope, m);
    },
    progressEnd: () => {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
    },
  };
}

export type Logger = ReturnType<typeof logger>;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
