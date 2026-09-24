/**
 * Minimal, dependency-free HTML -> readable text converter. It is not a full
 * HTML parser; it is designed to give an LLM the readable content of a page:
 * drops script/style/etc., keeps headings, paragraphs, list items and links.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

const DROP =
  /<(script|style|noscript|template|svg|iframe|object|canvas|head|title)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
  /<\/?(p|div|section|article|header|footer|main|aside|nav|table|tr|ul|ol|dl|dt|dd|blockquote|pre|form|fieldset|figure|figcaption|hr|br)\b[^>]*>/gi;

export function htmlToText(html: string): { title: string | undefined; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch?.[1] ? collapse(decodeEntities(titleMatch[1])) : undefined;
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, ' ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(td|th)\b[^>]*>/gi, ' | ');
  s = s.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, h1: string | undefined, h2: string | undefined, inner: string) => {
      const href = h1 ?? h2 ?? '';
      const label = inner.replace(/<[^>]*>/g, '').trim();
      if (!label) return '';
      return /^(https?:|\/)/i.test(href) ? `[${label}](${href})` : label;
    },
  );
  s = s.replace(BLOCK, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  const lines = s
    .split('\n')
    .map((l) => collapse(l))
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''));
  return { title, text: lines.join('\n').trim() };
}

function collapse(s: string): string {
  return s.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim();
}
