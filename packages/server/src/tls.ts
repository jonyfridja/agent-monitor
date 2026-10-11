import { execFile } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface TlsFiles {
  key: string;
  cert: string;
  /** The SHA-256 fingerprint, so the user can check it against what the phone shows. */
  fingerprint: string;
  selfSigned: boolean;
}

const run = promisify(execFile);

/** Names a phone might reach this Mac by: its LAN IPs, localhost and `name.local`. */
export function certNames(ips: readonly string[]): string[] {
  const me = hostname().replace(/\.local$/i, '');
  return [...new Set([...ips.map((ip) => `IP:${ip}`), 'IP:127.0.0.1', 'DNS:localhost', `DNS:${me}`, `DNS:${me}.local`])];
}

const fingerprint = (certPem: string): string => new X509Certificate(certPem).fingerprint256;

/**
 * Use the user's own cert (e.g. from mkcert) when configured; otherwise keep a self-signed one in `dir`,
 * re-issued when the Mac's LAN address is no longer in it (DHCP gave it a new IP).
 */
export async function ensureCert(
  dir: string,
  ips: readonly string[],
  custom?: { cert?: string; key?: string },
): Promise<TlsFiles> {
  if (custom?.cert && custom?.key) {
    const [cert, key] = await Promise.all([readFile(custom.cert, 'utf8'), readFile(custom.key, 'utf8')]);
    return { cert, key, fingerprint: fingerprint(cert), selfSigned: false };
  }
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const namesPath = join(dir, 'names.json');
  const names = certNames(ips);
  try {
    const have: string[] = JSON.parse(await readFile(namesPath, 'utf8'));
    if (names.every((n) => have.includes(n))) {
      const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
      const days = (Date.parse(new X509Certificate(cert).validTo) - Date.now()) / 86_400_000;
      if (days > 7) return { cert, key, fingerprint: fingerprint(cert), selfSigned: true };
    }
  } catch {
    // missing or unreadable: issue a new one
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpKey = `${keyPath}.tmp`;
  const tmpCert = `${certPath}.tmp`;
  // The key comes from Node: macOS's LibreSSL would encode explicit curve parameters, which browsers reject.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(tmpKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  // 825 days is the longest validity Apple platforms accept for a server certificate.
  await run('openssl', [
    'req', '-new', '-x509', '-key', tmpKey, '-sha256', '-days', '825',
    '-subj', '/CN=agent-monitor', '-addext', `subjectAltName=${names.join(',')}`, '-addext', 'extendedKeyUsage=serverAuth',
    '-out', tmpCert,
  ], { timeout: 15_000 });
  await rename(tmpKey, keyPath);
  await rename(tmpCert, certPath);
  await writeFile(namesPath, JSON.stringify(names) + '\n');
  const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
  return { cert, key, fingerprint: fingerprint(cert), selfSigned: true };
}
