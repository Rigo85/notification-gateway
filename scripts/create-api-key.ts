// Uso: npm run create-key -- <nombre> [limite_por_hora]
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { generateToken, hashToken } from '../src/auth.js';

const name = process.argv[2];
const rateLimit = Number(process.argv[3] ?? 20);
if (!name) {
  console.error('Uso: npm run create-key -- <nombre> [limite_por_hora]');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
const token = generateToken();
await db.query(
  `INSERT INTO api_keys (name, key_hash, rate_limit_per_hour) VALUES ($1, $2, $3)`,
  [name, hashToken(token), rateLimit],
);
console.log(`API key creada para '${name}' (límite ${rateLimit}/hora).`);
console.log(`Token (guárdalo, no se vuelve a mostrar):\n\n  ${token}\n`);
await db.end();
