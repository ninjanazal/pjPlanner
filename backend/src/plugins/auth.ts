import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
// The write key (env WRITE_KEY, from .env; MCP_API_KEY is the old name). Anyone writing, the web UI included, must send it as
// `x-api-key`. Unset means writes are open, which only tests and ad-hoc embedding rely on: index.ts refuses to start without it.
export const writeKey = () => process.env.WRITE_KEY || process.env.MCP_API_KEY || '';
const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerAuth(app: FastifyInstance) {
  // Agents identify themselves with `x-agent: mcp` and must present the key for any write. A wrong key is
  // rejected on any request. The web UI sends neither header and is unaffected.
  app.addHook('onRequest', async (req, reply) => {
    const key = writeKey();
    if (!key || !req.url.startsWith('/api/')) return;
    const sent = req.headers['x-api-key'];
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if ((sent !== undefined || write) && !(typeof sent === 'string' && sameKey(sent, key))) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid API key' } });
    }
  });
}
