// Uso: npm run create-admin -- <usuario> <contraseña>
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/admin/session.js';

const [username, password] = [process.argv[2], process.argv[3]];
if (!username || !password || password.length < 8) {
  console.error('Uso: npm run create-admin -- <usuario> <contraseña>  (mínimo 8 caracteres)');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
await db.query(
  `INSERT INTO users (username, password_hash) VALUES ($1, $2)
   ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
  [username, hashPassword(password)],
);
console.log(`Usuario '${username}' creado/actualizado.`);
await db.end();
