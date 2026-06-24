// Structured JSON-line logger with secret redaction.
//
// Every significant event is emitted as a single JSON object on one line so the
// output is greppable and machine-parseable. Secrets registered via addSecret()
// are scrubbed from every emitted line as a defense-in-depth measure.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
} & Record<string, unknown>;

export type LogSink = (record: LogRecord, line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  /** Custom sink (used by tests); defaults to writing a JSON line to stdout. */
  sink?: LogSink;
}

export class Logger {
  private readonly secrets = new Set<string>();
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly base: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}, base: Record<string, unknown> = {}) {
    this.level = opts.level ?? 'info';
    this.sink = opts.sink ?? ((_rec, line) => process.stdout.write(line + '\n'));
    this.base = base;
  }

  /** Register a secret value to be redacted from all future output. */
  addSecret(value: string | undefined | null): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  /** Create a child logger that always includes the given context fields. */
  child(context: Record<string, unknown>): Logger {
    const c = new Logger({ level: this.level, sink: this.sink }, { ...this.base, ...context });
    for (const s of this.secrets) c.addSecret(s);
    return c;
  }

  private redact(line: string): string {
    let out = line;
    for (const secret of this.secrets) {
      // Split/join avoids RegExp escaping concerns and replaces all occurrences.
      out = out.split(secret).join('***');
    }
    return out;
  }

  private emit(level: LogLevel, event: string, fields: Record<string, unknown>, msg?: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(msg ? { msg } : {}),
      ...this.base,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, event, msg: '<<unserializable record>>' });
    }
    this.sink(record, this.redact(line));
  }

  debug(event: string, fields: Record<string, unknown> = {}, msg?: string): void {
    this.emit('debug', event, fields, msg);
  }
  info(event: string, fields: Record<string, unknown> = {}, msg?: string): void {
    this.emit('info', event, fields, msg);
  }
  warn(event: string, fields: Record<string, unknown> = {}, msg?: string): void {
    this.emit('warn', event, fields, msg);
  }
  error(event: string, fields: Record<string, unknown> = {}, msg?: string): void {
    this.emit('error', event, fields, msg);
  }
}
