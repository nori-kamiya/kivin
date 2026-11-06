// IP allow / deny lists (equivalent of Hono's `ipRestriction`): exact addresses, CIDR ranges, `*`
// and predicates, for IPv4 and IPv6 (IPv4-mapped IPv6 addresses count as IPv4).
import { forbidden, getClientAddress, type CanActivate } from '@kivin/core';

/** `'10.0.0.0/8'`, `'2001:db8::/32'`, `'192.168.1.5'`, `'::1'`, `'*'`, or a predicate on the address. */
export type IpRule = string | ((address: string) => boolean);

interface ParsedAddress {
  family: 4 | 6;
  bytes: Uint8Array;
}

function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    // Decimal only, no leading zeros (`010` is octal in some parsers: refuse rather than guess).
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) {
      return undefined;
    }
    bytes[index] = Number(part);
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | undefined {
  const zone = text.indexOf('%');
  const address = (zone === -1 ? text : text.slice(0, zone)).toLowerCase();
  if (address.length === 0 || /[^0-9a-f:.]/.test(address)) {
    return undefined;
  }
  const doubleColon = address.indexOf('::');
  if (doubleColon !== -1 && address.indexOf('::', doubleColon + 1) !== -1) {
    return undefined;
  }
  const parseGroups = (part: string): number[] | undefined => {
    if (part === '') {
      return [];
    }
    const groups: number[] = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (index === pieces.length - 1 && piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4) {
          return undefined;
        }
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) {
        return undefined;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  let groups: number[];
  if (doubleColon === -1) {
    const parsed = parseGroups(address);
    if (!parsed || parsed.length !== 8) {
      return undefined;
    }
    groups = parsed;
  } else {
    const head = parseGroups(address.slice(0, doubleColon));
    const tail = parseGroups(address.slice(doubleColon + 2));
    if (!head || !tail || head.length + tail.length > 7) {
      return undefined;
    }
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** Parses an IPv4 / IPv6 address; `::ffff:a.b.c.d` is returned as IPv4. */
export function parseIpAddress(text: string): ParsedAddress | undefined {
  const trimmed = text.trim();
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (!unbracketed.includes(':')) {
    const bytes = parseIpv4(unbracketed);
    return bytes ? { family: 4, bytes } : undefined;
  }
  const bytes = parseIpv6(unbracketed);
  if (!bytes) {
    return undefined;
  }
  if (IPV4_MAPPED_PREFIX.every((value, index) => bytes[index] === value)) {
    return { family: 4, bytes: bytes.slice(12) };
  }
  return { family: 6, bytes };
}

type Matcher = (address: ParsedAddress, raw: string) => boolean;

function compileRule(rule: IpRule): Matcher {
  if (typeof rule === 'function') {
    return (_address, raw) => rule(raw);
  }
  const text = rule.trim();
  if (text === '*') {
    return () => true;
  }
  const slash = text.indexOf('/');
  const network = parseIpAddress(slash === -1 ? text : text.slice(0, slash));
  if (!network) {
    throw new TypeError(`Invalid IP rule: ${JSON.stringify(rule)}`);
  }
  const maxPrefix = network.family === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (slash !== -1) {
    const prefixText = text.slice(slash + 1);
    prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
    // `::ffff:10.0.0.0/104` is an IPv4 range written as IPv6.
    if (network.family === 4 && text.slice(0, slash).includes(':')) {
      prefix -= 96;
    }
    if (!(prefix >= 0 && prefix <= maxPrefix)) {
      throw new TypeError(`Invalid IP rule prefix: ${JSON.stringify(rule)}`);
    }
  }
  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  const mask = remainingBits === 0 ? 0 : (0xff << (8 - remainingBits)) & 0xff;
  return (address) => {
    if (address.family !== network.family) {
      return false;
    }
    for (let index = 0; index < fullBytes; index += 1) {
      if (address.bytes[index] !== network.bytes[index]) {
        return false;
      }
    }
    return mask === 0 || (address.bytes[fullBytes]! & mask) === (network.bytes[fullBytes]! & mask);
  };
}

/** A reusable test for a list of rules (`true` when any rule matches; invalid rules throw up front). */
export function createIpMatcher(rules: readonly IpRule[]): (address: string) => boolean {
  const matchers = rules.map(compileRule);
  return (raw) => {
    const address = parseIpAddress(raw);
    return address !== undefined && matchers.some((matcher) => matcher(address, raw));
  };
}

export interface IpRestrictionOptions {
  /** When given (non-empty), only matching addresses pass. */
  allow?: readonly IpRule[];
  /** Matching addresses are refused, even when they are also allowed. */
  deny?: readonly IpRule[];
  /**
   * The client address. Default: the peer address (`getClientAddress`). Behind a reverse proxy,
   * read the address the proxy sets, e.g. the last hop it appended to `X-Forwarded-For`.
   */
  getAddress?: (request: Request) => string | undefined;
  /** What to do when the address is unknown or unparsable. Default `'deny'` (fail closed). */
  unknown?: 'allow' | 'deny';
}

/** Whether `request` passes the lists (see `IpRestrictionOptions`). */
export function createIpRestriction(options: IpRestrictionOptions): (request: Request) => boolean {
  const allow = options.allow && options.allow.length > 0 ? createIpMatcher(options.allow) : undefined;
  const deny = options.deny && options.deny.length > 0 ? createIpMatcher(options.deny) : undefined;
  if (!allow && !deny) {
    throw new TypeError('createIpRestriction: give at least one allow or deny rule');
  }
  const getAddress = options.getAddress ?? getClientAddress;
  const allowUnknown = options.unknown === 'allow';

  return (request) => {
    const address = getAddress(request);
    if (address === undefined || parseIpAddress(address) === undefined) {
      return allowUnknown;
    }
    if (deny?.(address)) {
      return false;
    }
    return allow ? allow(address) : true;
  };
}

/**
 * Guard answering `403` for addresses outside the allow list / inside the deny list. Use it per route
 * (`@UseGuards`) or app-wide (`globals.guards`). To protect every request, including native static
 * routes, use `createIpRestriction` in an `onRequest` hook instead.
 */
export function createIpRestrictionGuard(options: IpRestrictionOptions) {
  const passes = createIpRestriction(options);
  return class IpRestrictionGuard implements CanActivate {
    canActivateRaw(request: Request) {
      if (!passes(request)) {
        throw forbidden();
      }
      return true;
    }

    canActivate(context: { request: Request }) {
      return this.canActivateRaw(context.request);
    }
  };
}
