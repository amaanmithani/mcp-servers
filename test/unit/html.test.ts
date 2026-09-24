import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../../src/servers/http/html.ts';

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &copy; &bogus; &#0;')).toBe(
      'a & b <c> AB © &bogus; &#0;',
    );
  });
});

describe('htmlToText', () => {
  it('extracts title and readable text', () => {
    const html = `<!doctype html><html><head><title>My &amp; Page</title>
      <style>body{color:red}</style><script>alert("x")</script></head>
      <body><nav><a href="/home">Home</a></nav>
      <h1>Hello</h1><p>First   para with <b>bold</b>.</p><!-- hidden -->
      <ul><li>one</li><li>two</li></ul>
      <p>Link: <a href="https://example.com/x">example</a> and <a href="javascript:void(0)">js</a>
      <a href="/empty"></a></p>
      <table><tr><td>a</td><td>b</td></tr></table><br>end</body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe('My & Page');
    expect(text).toContain('# Hello');
    expect(text).toContain('First para with bold.');
    expect(text).toContain('- one\n- two');
    expect(text).toContain('[example](https://example.com/x)');
    expect(text).toContain('[Home](/home)');
    expect(text).toContain(' js');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('hidden');
    expect(text).toMatch(/\| a \| b/);
    expect(text.endsWith('end')).toBe(true);
  });
  it('handles documents without a title', () => {
    expect(htmlToText('<p>x</p>')).toEqual({ title: undefined, text: 'x' });
  });
});
