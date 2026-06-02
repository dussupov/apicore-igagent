import 'dotenv/config';
import { initDb } from './db.js';

await initDb();
console.log('Database initialized');
process.exit(0);
