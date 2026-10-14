import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
// Serves the built frontend; any other non-API GET falls back to index.html so client-side routes work.
export function registerStatic(app: FastifyInstance) {
  const staticDir = path.resolve(process.env.STATIC_DIR ?? '../frontend/dist');
  const staticIndex = fs.existsSync(path.join(staticDir, 'index.html')) ? path.join(staticDir, 'index.html') : null;
  const indexHtml = staticIndex ? fs.readFileSync(staticIndex) : null;
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && indexHtml) {
      return reply.type('text/html').send(indexHtml);
    }
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });
  if (staticIndex) app.register(fastifyStatic, { root: staticDir });
}
