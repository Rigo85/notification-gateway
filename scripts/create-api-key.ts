// Uso: npm run create-key -- <nombre> [corte_por_hora] [aviso_por_hora]
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { generateToken, hashToken } from '../src/auth.js';

const name = process.argv[2];
const rateLimit = Number(process.argv[3] ?? 120);
const warningLimit = Number(process.argv[4] ?? Math.min(60, rateLimit));
if (!name) {
  console.error('Uso: npm run create-key -- <nombre> [corte_por_hora] [aviso_por_hora]');
  process.exit(1);
}
if (!Number.isInteger(rateLimit) || !Number.isInteger(warningLimit) || warningLimit < 1 || warningLimit > rateLimit) {
  console.error('Los límites deben ser enteros positivos y el aviso no puede superar el corte.');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
const token = generateToken();
await db.query(
  `INSERT INTO api_keys (name, key_hash, warning_limit_per_hour, rate_limit_per_hour)
   VALUES ($1, $2, $3, $4)`,
  [name, hashToken(token), warningLimit, rateLimit],
);
console.log(`API key creada para '${name}' (aviso ${warningLimit}/hora, corte ${rateLimit}/hora).`);
console.log(`Token (guárdalo, no se vuelve a mostrar):\n\n  ${token}\n`);
await db.end();
