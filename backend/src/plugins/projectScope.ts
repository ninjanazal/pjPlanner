import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, notFound } from '../errors.js';
import { projectScope } from '../context.js';
// Routes that are not scoped to a project: project management itself, MCP downloads, Jira (except create-fields, which reads the active project), and the access/health probes.
export function registerProjectScope(app: FastifyInstance, db: Database.Database) {
  // The active project of the request: `x-project` header or `?project=`, else the oldest project. Kept in
  // AsyncLocalStorage so every query helper can scope itself without passing it around.
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/projects') || path.startsWith('/api/mcp') || (path.startsWith('/api/jira') && path !== '/api/jira/create-fields') || path === '/api/health' || path === '/api/access' || path === '/api/unlock') return done();
    let pid: number;
    try {
      const want = req.headers['x-project'] ?? (req.query as any)?.project;
      const row = (want === undefined
        ? db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get()
        : db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(want))) as { id: number } | undefined;
      if (!row) {
        if (want === undefined) throw new HttpError(404, 'no_project', 'No project yet; create one first');
        throw notFound('Project');
      }
      pid = row.id;
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      return reply.status(status).send({ error: { code: e instanceof HttpError ? e.code : 'internal_error', message: e.message } });
    }
    projectScope.run(pid, done); // outside the try: a failure further down the chain must not send a second reply
  });
}
