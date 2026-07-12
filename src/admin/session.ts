import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// --- contraseñas (scrypt de node:crypto, sin dependencias) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// --- cookie de sesión firmada (HMAC-SHA256) ---

const SESSION_TTL_S = 7 * 24 * 3600;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function createSession(username: string, secret: string): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S })),
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; exp: number };
    if (data.exp < Date.now() / 1000) return null;
    return data.u;
  } catch {
    return null;
  }
}

// --- rate limit de login (en memoria) ---

const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60_000;
const fails = new Map<string, { count: number; blockedUntil: number }>();

export function loginBlocked(ip: string): boolean {
  const entry = fails.get(ip);
  return !!entry && entry.blockedUntil > Date.now();
}

export function registerLoginFail(ip: string): void {
  const entry = fails.get(ip) ?? { count: 0, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILS) {
    entry.blockedUntil = Date.now() + BLOCK_MS;
    entry.count = 0;
  }
  fails.set(ip, entry);
}

export function clearLoginFails(ip: string): void {
  fails.delete(ip);
}
