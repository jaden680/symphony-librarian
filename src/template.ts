// Strict `{{ path.to.value }}` template renderer.
//
// SPEC MUST: "Unknown variables MUST fail rendering. Unknown filters MUST fail
// rendering." We support only dotted-path variable substitution (no filters),
// so any `|` filter syntax is by definition unknown and fails. A path that
// references a key absent from the context object throws; a key that exists but
// holds null/undefined renders as an empty string.

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => stringify(v)).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolvePath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = context;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      throw new TemplateError(`unknown variable: ${path}`);
    }
    if (!Object.prototype.hasOwnProperty.call(cur, part)) {
      throw new TemplateError(`unknown variable: ${path}`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface RenderOptions {
  /**
   * When true, every substituted value is POSIX single-quote escaped so it is
   * inert when interpolated into a `bash -lc` command line (defends against
   * command injection from untrusted tracker fields). Use for hook scripts, NOT
   * for the agent prompt.
   */
  shellEscape?: boolean;
}

/** POSIX single-quote escaping: 'foo' with embedded ' rewritten as '\''. */
export function shellQuote(value: string): string {
  return `'` + value.split(`'`).join(`'\\''`) + `'`;
}

/**
 * Render a template, substituting `{{ expr }}` occurrences. Throws TemplateError
 * on any unknown variable or unsupported filter expression.
 */
export function render(template: string, context: Record<string, unknown>, opts: RenderOptions = {}): string {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();
    if (expr.length === 0) {
      throw new TemplateError('empty template expression');
    }
    if (expr.includes('|')) {
      throw new TemplateError(`unsupported filter in expression: {{ ${expr} }}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(expr)) {
      throw new TemplateError(`unsupported template expression: {{ ${expr} }}`);
    }
    const value = stringify(resolvePath(context, expr));
    return opts.shellEscape ? shellQuote(value) : value;
  });
}
