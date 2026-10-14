import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeKey } from '../plugins/auth.js';
// First non-loopback IPv4 address of this machine (what other hosts on the LAN can reach).
export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

export function systemRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ status: 'ok' }));

  // Address agents should use to reach this server: the address the caller used to reach it (so it is always the
  // right host and port), unless that is loopback, then PUBLIC_URL, else the LAN IP.
  app.get('/api/mcp/info', async (req) => {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const hostname = String(host ?? '').replace(/:\d+$/, '');
    const loopback = !host || ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    let url: string;
    if (!loopback) {
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
      url = `${proto}://${host}`;
    } else {
      url = process.env.PUBLIC_URL || `http://${lanAddress() ?? 'localhost'}:${process.env.PORT ?? 3030}`;
    }
    return { url: url.replace(/\/$/, '') };
  });

  // Lets the web UI check a key before it stores it: the onRequest hook above has already rejected a wrong one.
  app.post('/api/unlock', async () => ({ ok: true, locked: Boolean(writeKey()) }));
  // Whether writes need a key at all, so the UI can skip the lock when running open.
  app.get('/api/access', async () => ({ locked: Boolean(writeKey()) }));

  // Self-contained MCP bundle (built from ../mcp) so users can download it from the UI.
  app.get('/api/mcp/download', async (_req, reply) => {
    const file = path.resolve(process.env.MCP_BUNDLE ?? '../mcp/dist/pjplanner-mcp.mjs');
    if (!fs.existsSync(file)) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'MCP bundle not built' } });
    }
    return reply
      .type('text/javascript')
      .header('content-disposition', 'attachment; filename="pjplanner-mcp.mjs"')
      .send(fs.readFileSync(file));
  });

  // The skill suite for Claude Code: one folder per skill, each holding a SKILL.md. Names are matched against the folder listing, never joined into a path.
  const skillsDir = () => path.resolve(process.env.MCP_SKILLS ?? '../mcp/skills');
  const skillNames = () => (fs.existsSync(skillsDir()) ? fs.readdirSync(skillsDir()).filter((n) => fs.existsSync(path.join(skillsDir(), n, 'SKILL.md'))).sort() : []);
  const sendSkill = (name: string, reply: any) => {
    if (!skillNames().includes(name)) return reply.status(404).send({ error: { code: 'not_found', message: 'Skill not found' } });
    return reply.type('text/markdown').send(fs.readFileSync(path.join(skillsDir(), name, 'SKILL.md')));
  };
  app.get('/api/mcp/skills', async () => skillNames().map((name) => {
    const description = /^description:\s*(.+)$/m.exec(fs.readFileSync(path.join(skillsDir(), name, 'SKILL.md'), 'utf8'))?.[1] ?? '';
    return { name, description };
  }));
  app.get('/api/mcp/skills/:name', async (req, reply) => sendSkill((req.params as { name: string }).name, reply));
  // Older installs fetch the mapping skill from here.
  app.get('/api/mcp/skill', async (_req, reply) => sendSkill('pjplanner-map', reply));
}
