import vm from 'node:vm';
import { ToolError } from '../../lib/errors.ts';

export const MAX_PATTERN_LENGTH = 500;

/**
 * Build a matcher for a user-supplied pattern. Regex patterns run inside a
 * `vm` context with a timeout, because a hostile pattern such as `(a+)+$`
 * backtracks catastrophically and would otherwise freeze the whole server
 * (ReDoS). V8 honours the vm timeout even mid-regex.
 */
export function compileMatcher(
  pattern: string,
  opts: { regex: boolean; caseSensitive: boolean },
): (lines: string[], budgetMs: number) => number[] {
  if (pattern.length === 0) throw new ToolError('INVALID_INPUT', 'pattern must not be empty');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ToolError('INVALID_INPUT', `pattern longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!opts.regex) {
    const needle = opts.caseSensitive ? pattern : pattern.toLowerCase();
    return (lines) => {
      const hits: number[] = [];
      lines.forEach((line, i) => {
        if ((opts.caseSensitive ? line : line.toLowerCase()).includes(needle)) hits.push(i);
      });
      return hits;
    };
  }
  try {
    new RegExp(pattern, opts.caseSensitive ? 'u' : 'iu');
  } catch (err) {
    throw new ToolError('INVALID_INPUT', `Invalid regex: ${(err as Error).message}`);
  }
  const context = vm.createContext({ pattern, flags: opts.caseSensitive ? 'u' : 'iu', lines: [] });
  const script = new vm.Script(
    '(() => { const re = new RegExp(pattern, flags); const out = []; ' +
      'for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i); return out; })()',
  );
  return (lines, budgetMs) => {
    context.lines = lines;
    try {
      return Array.from(
        script.runInContext(context, { timeout: Math.max(1, Math.floor(budgetMs)) }) as number[],
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new ToolError(
          'TIMEOUT',
          'Regex evaluation exceeded the time budget (possible ReDoS)',
        );
      }
      throw new ToolError('INTERNAL', 'Regex evaluation failed');
    } finally {
      context.lines = [];
    }
  };
}
