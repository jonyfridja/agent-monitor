import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
export const MIN_PASSWORD = 6;
/** What a fresh install starts with. The host window nags until it's changed. */
export const DEFAULT_PASSWORD = '123456';

/** `scrypt$N$r$p$salt$hash` (base64url). Only the hash is ever stored. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(key, expected);
}

/** Constant-time string compare (for the pairing token). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Stateless session cookies: `<expiry>.<hmac>`. The key mixes the server secret with the current password hash,
 * so changing the password logs every phone out without keeping a session table.
 */
export class Sessions {
  #key: Buffer;
  readonly ttlMs: number;
  constructor(secret: string, credential: string, ttlMs = 30 * 24 * 3600_000) {
    this.ttlMs = ttlMs;
    this.#key = createHmac('sha256', secret).update(credential).digest();
  }

  issue(now = Date.now()): string {
    const exp = String(now + this.ttlMs);
    return `${exp}.${this.#sign(exp)}`;
  }

  valid(cookie: string | undefined, now = Date.now()): boolean {
    if (!cookie) return false;
    const [exp, sig] = cookie.split('.');
    if (!exp || !sig || !(Number(exp) > now)) return false;
    return safeEqual(sig, this.#sign(exp));
  }

  #sign(exp: string): string {
    return createHmac('sha256', this.#key).update(exp).digest('base64url');
  }
}

/** Per-IP login throttle: `max` failures per `windowMs`, then locked out until the window passes. */
export class LoginLimiter {
  #fails = new Map<string, { count: number; first: number }>();
  readonly max: number;
  readonly windowMs: number;
  constructor(max = 5, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Milliseconds until this IP may try again; 0 = allowed now. */
  retryAfter(ip: string, now = Date.now()): number {
    const f = this.#fails.get(ip);
    if (!f) return 0;
    if (now - f.first >= this.windowMs) {
      this.#fails.delete(ip);
      return 0;
    }
    return f.count >= this.max ? f.first + this.windowMs - now : 0;
  }

  fail(ip: string, now = Date.now()): void {
    const f = this.#fails.get(ip);
    if (!f || now - f.first >= this.windowMs) this.#fails.set(ip, { count: 1, first: now });
    else f.count++;
  }

  succeed(ip: string): void {
    this.#fails.delete(ip);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed escape: ignore that cookie
    }
  }
  return out;
}

/**
 * DNS-rebinding guard: a browser only sends a `Host` we didn't choose when some other site's domain resolves to us.
 * Accept IP literals, localhost and this Mac's own names (`name.local`).
 */
export function allowedHost(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host) return true; // only non-browser HTTP/1.0 clients omit it; browsers always send one
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (/^[\d.]+$/.test(name) || name.includes(':')) return true; // IPv4 / IPv6 literal
  const me = osHostname().toLowerCase().replace(/\.local$/, '');
  return ['localhost', me, `${me}.local`, ...extra.map((h) => h.toLowerCase())].includes(name);
}
