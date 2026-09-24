import { BlockList, isIP } from 'node:net';

/**
 * SSRF address policy. Every address a request could connect to is checked
 * here AFTER DNS resolution, so a public-looking hostname that resolves to
 * 127.0.0.1 / 169.254.169.254 / 10.x is refused.
 *
 * IPv6 forms that embed an IPv4 address (IPv4-mapped ::ffff:a.b.c.d, NAT64
 * 64:ff9b::/96, 6to4 2002::/16) are unwrapped and the embedded IPv4 address is
 * checked too, because stacks may route them to the embedded v4 host.
 */

const V4_BLOCKED: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const V6_BLOCKED: Array<[string, number, string]> = [
  ['::', 96, 'IPv4-compatible / unspecified / loopback'],
  ['64:ff9b:1::', 48, 'local-use NAT64'],
  ['100::', 64, 'discard-only'],
  ['2001::', 23, 'IETF protocol assignments (incl. Teredo)'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'SRv6 SIDs'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local (deprecated)'],
  ['ff00::', 8, 'multicast'],
];

function buildList(entries: Array<[string, number, string]>, family: 'ipv4' | 'ipv6') {
  return entries.map(([net, prefix, reason]) => {
    const bl = new BlockList();
    bl.addSubnet(net, prefix, family);
    return { bl, reason, family };
  });
}

const V4_RULES = buildList(V4_BLOCKED, 'ipv4');
const V6_RULES = buildList(V6_BLOCKED, 'ipv6');

/** Expand an IPv6 string (optionally with a dotted IPv4 tail) into 8 16-bit groups. */
export function expandIPv6(addr: string): number[] {
  let s = addr.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail?.[1]) {
    const o = tail[1].split('.').map(Number) as [number, number, number, number];
    s =
      s.slice(0, -tail[1].length) +
      ((o[0] << 8) | o[1]).toString(16) +
      ':' +
      ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? [] : new Array<string>(8 - h.length - r.length).fill('0');
  return [...h, ...fill, ...r].map((x) => parseInt(x, 16));
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** If an IPv6 address embeds an IPv4 address that could be routed to, return it. */
export function embeddedIPv4(addr: string): string | undefined {
  const g = expandIPv6(addr);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // ::ffff:a.b.c.d  (IPv4-mapped)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return v4FromGroups(g6, g7);
  }
  // 64:ff9b::a.b.c.d  (well-known NAT64 prefix)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4FromGroups(g6, g7);
  }
  // 2002:AABB:CCDD::/48  (6to4)
  if (g0 === 0x2002) return v4FromGroups(g1, g2);
  return undefined;
}

export interface AddressVerdict {
  blocked: boolean;
  reason?: string;
}

export interface AddressPolicy {
  /** CIDRs explicitly exempted from blocking, e.g. ["10.1.2.0/24"]. Use with care. */
  allowCidrs?: string[];
}

export function compileExemptions(cidrs: string[] = []): BlockList {
  const bl = new BlockList();
  for (const c of cidrs) {
    const [net, prefix] = c.split('/') as [string, string | undefined];
    const fam = isIP(net);
    if (fam === 0) throw new Error(`Invalid CIDR in allowCidrs: ${c}`);
    const bits = prefix === undefined ? (fam === 4 ? 32 : 128) : Number(prefix);
    bl.addSubnet(net, bits, fam === 4 ? 'ipv4' : 'ipv6');
  }
  return bl;
}

/** Decide whether connecting to `address` (an IP literal) is allowed. */
export function checkAddress(address: string, exempt: BlockList = new BlockList()): AddressVerdict {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // strip brackets / zone id
  const fam = isIP(ip);
  if (fam === 0) return { blocked: true, reason: 'not an IP address' };
  if (fam === 4) {
    if (exempt.check(ip, 'ipv4')) return { blocked: false };
    const rule = V4_RULES.find((r) => r.bl.check(ip, 'ipv4'));
    return rule ? { blocked: true, reason: rule.reason } : { blocked: false };
  }
  const v4 = embeddedIPv4(ip);
  if (v4 !== undefined) {
    const inner = checkAddress(v4, exempt);
    if (inner.blocked) return { blocked: true, reason: `embedded IPv4 ${v4}: ${inner.reason}` };
    // A mapped address is the v4 host itself; NAT64/6to4 are fine if the v4 host is public.
    return { blocked: false };
  }
  if (exempt.check(ip, 'ipv6')) return { blocked: false };
  const rule = V6_RULES.find((r) => r.bl.check(ip, 'ipv6'));
  return rule ? { blocked: true, reason: rule.reason } : { blocked: false };
}
