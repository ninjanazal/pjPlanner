import type { FastifyInstance } from 'fastify';
import { conflict, notFound } from '../errors.js';
import { P, projectScope } from '../context.js';
import { obj, str } from '../validation.js';

// Single-editor lease per project, held in memory (a restart frees every lock). A browser tab identifies itself with
// `x-client` (+ `x-client-name`); while another client holds an unexpired lease its writes answer 409. Requests without
// `x-client` (agents, scripts) are not subject to the lease: the write key guards them. A holder keeps the lease with a
// heartbeat; it also pushes `changed` and `editor` events to everyone watching the project over SSE.
export const LEASE_MS = 30_000;
type Lease = { clientId: string; name: string; expires: number };
type Editor = { clientId: string; name: string } | null;
type Sink = { write: (chunk: string) => void };

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const clientName = (v: string | string[] | undefined) => { try { return decodeURIComponent(header(v)).slice(0, 40) || 'Anonymous'; } catch { return 'Anonymous'; } };

export function registerEditorLock(app: FastifyInstance) {
  const leases = new Map<number, Lease>();
  const watchers = new Map<number, Set<Sink>>();
  const pids = new WeakMap<object, number>(); // project of a guarded write, read again by the onResponse broadcaster

  const holder = (pid: number): Lease | null => {
    const l = leases.get(pid);
    if (l && l.expires <= Date.now()) { leases.delete(pid); emit(pid, 'editor', { editor: null }); return null; }
    return l ?? null;
  };
  const view = (l: Lease | null): Editor => (l ? { clientId: l.clientId, name: l.name } : null);
  const emit = (pid: number, event: string, data: unknown) => {
    for (const w of watchers.get(pid) ?? []) w.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const take = (pid: number, clientId: string, name: string) => {
    const before = leases.get(pid);
    leases.set(pid, { clientId, name, expires: Date.now() + LEASE_MS });
    if (!before || before.clientId !== clientId) emit(pid, 'editor', { editor: { clientId, name } });
  };

  // Expire silent holders so watchers learn the project is free without anyone having to write.
  const sweeper = setInterval(() => { for (const pid of [...leases.keys()]) holder(pid); }, 5_000);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    for (const set of watchers.values()) for (const w of set) (w as any).end?.();
  });

  const EDITOR_PATHS = new Set(['/api/editor/claim', '/api/editor/heartbeat', '/api/editor/release']);
  // The project a write touches: the request scope, or the `:id` of `/api/projects/:id...` (settings, delete, Jira import),
  // which the scope plugin leaves unscoped. Creating or importing a project touches no existing one.
  const projectOf = (path: string): number | undefined => {
    const pid = projectScope.getStore();
    if (pid !== undefined) return pid;
    const m = /^\/api\/projects\/(\d+)(\/|$)/.exec(path);
    return m ? Number(m[1]) : undefined;
  };

  // Refuse writes while someone else holds the lease; the lease itself is only taken once the write succeeded.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || EDITOR_PATHS.has(path)) return;
    const pid = projectOf(path);
    if (pid === undefined) return;
    pids.set(req, pid);
    const clientId = header(req.headers['x-client']);
    if (!clientId) return; // agents and scripts: not subject to the lease, but their writes are still broadcast
    const l = holder(pid);
    if (l && l.clientId !== clientId) throw conflict(`${l.name} is editing`, { editor: view(l) });
  });

  app.addHook('onResponse', async (req, reply) => {
    const pid = pids.get(req);
    if (pid === undefined || reply.statusCode >= 400) return;
    const clientId = header(req.headers['x-client']);
    if (req.method === 'DELETE' && req.url.split('?')[0] === `/api/projects/${pid}`) {
      emit(pid, 'changed', { by: clientId });
      leases.delete(pid);
      for (const w of watchers.get(pid) ?? []) (w as any).end?.();
      watchers.delete(pid);
      return;
    }
    if (clientId) take(pid, clientId, clientName(req.headers['x-client-name']));
    emit(pid, 'changed', { by: clientId });
  });

  app.get('/api/editor', async () => ({ editor: view(holder(P())) }));

  app.post('/api/editor/claim', async (req) => {
    const clientId = header(req.headers['x-client']);
    if (!clientId) throw conflict('x-client header required');
    const b = obj(req.body ?? {});
    const name = b.name !== undefined ? str(b.name, 'name').slice(0, 40) : clientName(req.headers['x-client-name']);
    const l = holder(P());
    if (l && l.clientId !== clientId && b.force !== true) throw conflict(`${l.name} is editing`, { editor: view(l) });
    take(P(), clientId, name);
    return { editor: view(leases.get(P())!) };
  });

  app.post('/api/editor/heartbeat', async (req) => {
    const l = holder(P());
    if (!l || l.clientId !== header(req.headers['x-client'])) throw conflict('You are no longer the editor', { editor: view(l) });
    l.expires = Date.now() + LEASE_MS;
    return { editor: view(l) };
  });

  app.post('/api/editor/release', async (req) => {
    const l = holder(P());
    if (l && l.clientId === header(req.headers['x-client'])) { leases.delete(P()); emit(P(), 'editor', { editor: null }); }
    return { editor: view(holder(P())) };
  });

  // Server-sent events for the active project (`?project=`, since EventSource cannot send headers).
  app.get('/api/events', (req, reply) => {
    const pid = P();
    if (pid === undefined) throw notFound('Project');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const sink = res as unknown as Sink;
    res.write(`event: editor\ndata: ${JSON.stringify({ editor: view(holder(pid)) })}\n\n`);
    if (!watchers.has(pid)) watchers.set(pid, new Set());
    watchers.get(pid)!.add(sink);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const drop = () => {
      clearInterval(ping);
      const set = watchers.get(pid);
      set?.delete(sink);
      if (set?.size === 0) watchers.delete(pid);
    };
    req.raw.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  });
}
