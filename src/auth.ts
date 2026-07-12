import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Db } from './db.js';

export interface ApiKeyInfo {
  id: number;
  name: string;
  channelsAllowed: string[];
  rateLimitPerHour: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyInfo;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return `ngw_${randomBytes(24).toString('hex')}`;
}

export function makeAuthHook(db: Db) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      await reply.code(401).send({ error: 'Falta Authorization: Bearer <api-key>' });
      return;
    }
    const { rows } = await db.query<{
      id: number;
      name: string;
      channels_allowed: string[];
      rate_limit_per_hour: number;
    }>(
      `UPDATE api_keys SET last_used_at = now()
       WHERE key_hash = $1 AND enabled
       RETURNING id, name, channels_allowed, rate_limit_per_hour`,
      [hashToken(token)],
    );
    const key = rows[0];
    if (!key) {
      await reply.code(401).send({ error: 'API key inválida o deshabilitada' });
      return;
    }
    req.apiKey = {
      id: key.id,
      name: key.name,
      channelsAllowed: key.channels_allowed,
      rateLimitPerHour: key.rate_limit_per_hour,
    };
  };
}
