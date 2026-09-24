import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { ToolError } from '../../lib/errors.ts';
import type { HttpConfig } from './config.ts';
import { htmlToText } from './html.ts';
import { checkAddress, compileExemptions } from './ipguard.ts';

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

const TEXTUAL =
  /^(text\/[\w.+-]+|application\/(json|xml|xhtml\+xml|javascript|[\w.-]+\+(json|xml)))$/i;

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string | null;
  text: string;
  bytes: number;
  truncated: boolean;
  redirects: string[];
}

/** Case-insensitive host allowlist check. `*.example.com` matches subdomains only. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase().replace(/\.$/, '');
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

export class Fetcher {
  private readonly exempt;
  private readonly cfg: HttpConfig;
  private readonly resolver: Resolver;

  constructor(cfg: HttpConfig, resolver: Resolver = defaultResolver) {
    this.cfg = cfg;
    this.resolver = resolver;
    this.exempt = compileExemptions(cfg.allowCidrs);
  }

  /** Validate a URL against scheme / port / host allowlists. Throws FORBIDDEN on failure. */
  checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError('INVALID_INPUT', `Invalid URL: ${raw}`);
    }
    const scheme = url.protocol.replace(/:$/, '');
    if (!(this.cfg.allowedSchemes as string[]).includes(scheme)) {
      throw new ToolError('FORBIDDEN', `Scheme not allowed: ${scheme}`);
    }
    if (url.username || url.password) {
      throw new ToolError('FORBIDDEN', 'Credentials in URLs are not allowed');
    }
    const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
    if (!this.cfg.allowedPorts.includes(port)) {
      throw new ToolError('FORBIDDEN', `Port not allowed: ${port}`);
    }
    // The WHATWG parser canonicalises tricks like http://0x7f.1/ to 127.0.0.1 here.
    if (!hostAllowed(url.hostname, this.cfg.allowedHosts)) {
      throw new ToolError('FORBIDDEN', `Host not in allowlist: ${url.hostname}`);
    }
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) this.assertAddress(literal);
    return url;
  }

  private assertAddress(address: string): void {
    const v = checkAddress(address, this.exempt);
    if (v.blocked) {
      throw new ToolError('FORBIDDEN', `Blocked address ${address} (${v.reason})`);
    }
  }

  /**
   * DNS lookup hook handed to http(s).request. The socket connects to exactly
   * the addresses validated here, so there is no window for DNS rebinding
   * between "check" and "connect". If ANY resolved address is blocked the
   * request fails (an attacker controlling DNS could otherwise mix in 127.0.0.1).
   */
  private lookup: LookupFunction = (hostname, options, callback) => {
    this.resolver(hostname).then(
      (addrs) => {
        try {
          if (addrs.length === 0)
            throw new ToolError('UPSTREAM_ERROR', `No addresses for ${hostname}`);
          for (const a of addrs) this.assertAddress(a.address);
        } catch (err) {
          callback(err as NodeJS.ErrnoException, '', 0);
          return;
        }
        if (options.all) callback(null, addrs as never);
        else {
          const first = addrs[0] as { address: string; family: number };
          callback(null, first.address, first.family);
        }
      },
      (err: Error) =>
        callback(
          new ToolError(
            'UPSTREAM_ERROR',
            `DNS lookup failed for ${hostname}: ${err.message}`,
          ) as never,
          '',
          0,
        ),
    );
  };

  async fetch(rawUrl: string, maxBytesArg?: number): Promise<FetchResult> {
    const maxBytes = Math.min(maxBytesArg ?? this.cfg.maxBytes, this.cfg.maxBytes);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const redirects: string[] = [];
    try {
      let url = this.checkUrl(rawUrl);
      for (;;) {
        const res = await this.request(url, controller.signal);
        const location = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume();
          if (redirects.length >= this.cfg.maxRedirects) {
            throw new ToolError('FORBIDDEN', `Too many redirects (max ${this.cfg.maxRedirects})`);
          }
          // Every hop is re-validated: a redirect to a disallowed host/scheme/IP is refused.
          const next = new URL(location, url);
          redirects.push(next.toString());
          url = this.checkUrl(next.toString());
          continue;
        }
        return await this.readBody(rawUrl, url, res, maxBytes, redirects);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ToolError('TIMEOUT', `Fetch exceeded ${this.cfg.timeoutMs} ms`);
      }
      if (err instanceof ToolError) throw err;
      throw new ToolError('UPSTREAM_ERROR', `Fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method: 'GET',
        signal,
        agent: false,
        lookup: this.lookup,
        headers: {
          'user-agent': this.cfg.userAgent,
          accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
        },
      });
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });
  }

  private async readBody(
    requested: string,
    url: URL,
    res: IncomingMessage,
    maxBytes: number,
    redirects: string[],
  ): Promise<FetchResult> {
    const contentType = (res.headers['content-type'] ?? 'application/octet-stream')
      .split(';')[0]!
      .trim();
    if (!TEXTUAL.test(contentType)) {
      res.destroy();
      throw new ToolError('UPSTREAM_ERROR', `Unsupported content type: ${contentType}`);
    }
    // Decompression happens before the byte cap, so a gzip bomb is cut off at maxBytes.
    const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
    let stream: Readable = res;
    if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(createGunzip());
    else if (enc === 'deflate') stream = res.pipe(createInflate());
    else if (enc === 'br') stream = res.pipe(createBrotliDecompress());
    else if (enc !== 'identity') {
      res.destroy();
      throw new ToolError('UPSTREAM_ERROR', `Unsupported content encoding: ${enc}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (total + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - total));
          total = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally {
      res.destroy();
      stream.destroy();
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const isHtml = /html/i.test(contentType);
    const { title, text } = isHtml ? htmlToText(body) : { title: undefined, text: body };
    return {
      url: requested,
      finalUrl: url.toString(),
      status: res.statusCode ?? 0,
      contentType,
      title: title ?? null,
      text,
      bytes: total,
      truncated,
      redirects,
    };
  }
}
