import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  workerDisabled: process.env.WORKER_DISABLED === 'true',
  // detrás de un reverse proxy (nginx del VPS): usar X-Forwarded-For como IP real
  trustProxy: process.env.TRUST_PROXY === 'true',
  smsProvider: process.env.SMS_PROVIDER ?? 'fake',
  goip: {
    baseUrl: process.env.GOIP_BASE_URL ?? '',
    user: process.env.GOIP_USER ?? '',
    password: process.env.GOIP_PASSWORD ?? '',
  },
};
