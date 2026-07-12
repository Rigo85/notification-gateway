import { config } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';

const db = createPool(config.databaseUrl);
await migrate(db, console.log);
console.log('migraciones al día');
await db.end();
