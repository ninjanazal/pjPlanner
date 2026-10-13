import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';

// Settings live in the repo's .env (see .env.example). Look next to the backend and one level up; real environment variables win.
for (const f of [path.resolve('.env'), path.resolve('..', '.env')]) {
  if (fs.existsSync(f)) { process.loadEnvFile(f); break; }
}
if (!process.env.WRITE_KEY && !process.env.MCP_API_KEY) {
  console.error('WRITE_KEY is not set. Copy .env.example to .env (make env) and choose a key; it is what unlocks editing.');
  process.exit(1);
}

const app = buildApp();
const port = Number(process.env.PORT ?? 3030);
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`pjPlanner listening on ${port}`));
