import { describe, expect, it } from 'vitest';
import {
  checkAddress,
  compileExemptions,
  embeddedIPv4,
  expandIPv6,
} from '../../src/servers/http/ipguard.ts';

describe('checkAddress: IPv4', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.10',
  ])('blocks %s', (ip) => expect(checkAddress(ip).blocked).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1', '192.169.0.1'])(
    'allows public %s',
    (ip) => expect(checkAddress(ip)).toEqual({ blocked: false }),
  );
});

describe('checkAddress: IPv6', () => {
  it.each([
    '::1',
    '::',
    '[::1]',
    'fe80::1',
    'fe80::1%lo0',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '::127.0.0.1', // IPv4-compatible (deprecated)
    '64:ff9b:1::1',
    'fec0::1',
  ])('blocks %s', (ip) => expect(checkAddress(ip).blocked).toBe(true));

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public %s', (ip) =>
    expect(checkAddress(ip).blocked).toBe(false),
  );
});

describe('checkAddress: IPv4 embedded in IPv6', () => {
  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::FFFF:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['0:0:0:0:0:ffff:10.0.0.1', 'private'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:c0a8:0101::1', 'private'],
  ])('blocks %s (%s)', (ip, reason) => {
    const v = checkAddress(ip);
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain(reason);
  });

  it('allows mapped / NAT64 / 6to4 forms of public addresses', () => {
    expect(checkAddress('::ffff:8.8.8.8').blocked).toBe(false);
    expect(checkAddress('64:ff9b::808:808').blocked).toBe(false);
    expect(checkAddress('2002:808:808::1').blocked).toBe(false);
  });
});

describe('helpers', () => {
  it('expands IPv6', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(expandIPv6('fe80::')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('extracts embedded IPv4', () => {
    expect(embeddedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIPv4('2606:4700::1')).toBeUndefined();
  });
  it('rejects non-IPs', () => expect(checkAddress('example.com').blocked).toBe(true));
  it('honours explicit exemptions, including via mapped addresses', () => {
    const ex = compileExemptions(['127.0.0.1/32', 'fd00::/8', '10.1.2.3']);
    expect(checkAddress('127.0.0.1', ex).blocked).toBe(false);
    expect(checkAddress('::ffff:127.0.0.1', ex).blocked).toBe(false);
    expect(checkAddress('127.0.0.2', ex).blocked).toBe(true);
    expect(checkAddress('fd00::5', ex).blocked).toBe(false);
    expect(checkAddress('10.1.2.3', ex).blocked).toBe(false);
    expect(() => compileExemptions(['nope/8'])).toThrow(/Invalid CIDR/);
  });
});
