import 'dotenv/config';
import { normalizeRecipient } from './sms-text.js';
import { parseTrustedProxies } from './trust-proxy.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function recipients(name: string): string[] {
  const values = (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return values.map((value) => {
    const normalized = normalizeRecipient(value);
    if (!normalized) throw new Error(`${name} contiene un destinatario inválido`);
    return normalized;
  }).filter((value, index, all) => all.indexOf(value) === index);
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  workerDisabled: process.env.WORKER_DISABLED === 'true',
  systemAlertRecipients: recipients('SYSTEM_ALERT_RECIPIENTS'),
  // Solo los proxies listados pueden aportar la IP real mediante X-Forwarded-For.
  trustProxy: parseTrustedProxies(process.env.TRUST_PROXY),
  smsProvider: process.env.SMS_PROVIDER ?? 'fake',
  goip: {
    baseUrl: process.env.GOIP_BASE_URL ?? '',
    user: process.env.GOIP_USER ?? '',
    password: process.env.GOIP_PASSWORD ?? '',
  },
};
