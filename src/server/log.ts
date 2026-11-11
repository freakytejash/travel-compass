// Structured JSON logging with redaction of sensitive fields.
const SENSITIVE = /(pass(word)?|token|secret|authorization|cookie|api[-_]?key|code_verifier|card|phone|email|refresh|access_token|traveller)/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(val, depth + 1);
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, ctx?: Record<string, unknown>) {
  if (order[level] < min || process.env.LOG_SILENT === '1') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(ctx ? (redact(ctx) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  redact,
};
