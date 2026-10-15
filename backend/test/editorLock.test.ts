import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';

let app: ReturnType<typeof buildApp>;
beforeEach(async () => {
  app = buildApp(':memory:');
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Test' } });
});
afterEach(async () => { vi.useRealTimers(); await app.close(); });

const as = (client: string, method: any, url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: { 'x-client': client, 'x-client-name': client } });

describe('editor lock', () => {
  it('claim, then a second client is refused', async () => {
    expect((await as('a', 'POST', '/api/editor/claim', {})).statusCode).toBe(200);
    const r = await as('b', 'POST', '/api/editor/claim', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.extra.editor.name).toBe('a');
  });
  it('force takes over, and the old holder loses its heartbeat', async () => {
    await as('a', 'POST', '/api/editor/claim', {});
    expect((await as('b', 'POST', '/api/editor/claim', { force: true })).statusCode).toBe(200);
    expect((await as('a', 'POST', '/api/editor/heartbeat')).statusCode).toBe(409);
    expect((await as('b', 'POST', '/api/editor/heartbeat')).statusCode).toBe(200);
  });
  it('blocks writes from a non-holder, allows the holder and clients without x-client', async () => {
    await as('a', 'POST', '/api/editor/claim', {});
    expect((await as('b', 'POST', '/api/modules', { name: 'M' })).statusCode).toBe(409);
    expect((await as('a', 'POST', '/api/modules', { name: 'M' })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/modules', payload: { name: 'N' } })).statusCode).toBe(201);
    expect((await as('b', 'GET', '/api/graph')).statusCode).toBe(200);
  });
  it('the first write claims a free lease', async () => {
    expect((await as('a', 'POST', '/api/modules', { name: 'M' })).statusCode).toBe(201);
    expect((await as('b', 'POST', '/api/modules', { name: 'N' })).statusCode).toBe(409);
  });
  it('a failed write does not take the lease', async () => {
    expect((await as('a', 'POST', '/api/modules', {})).statusCode).toBe(400);
    expect((await as('a', 'GET', '/api/editor')).json().editor).toBeNull();
    expect((await as('b', 'POST', '/api/modules', { name: 'N' })).statusCode).toBe(201);
  });
  it('project settings and Jira import are guarded by the lease', async () => {
    const pid = (await as('a', 'GET', '/api/projects')).json()[0].id;
    await as('a', 'POST', '/api/editor/claim', {});
    expect((await as('b', 'PUT', `/api/projects/${pid}`, { name: 'X' })).statusCode).toBe(409);
    expect((await as('b', 'POST', `/api/projects/${pid}/jira/import`, {})).statusCode).toBe(409);
    expect((await as('a', 'PUT', `/api/projects/${pid}`, { name: 'X' })).statusCode).toBe(200);
  });
  it('the lease expires without a heartbeat and release frees it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await as('a', 'POST', '/api/editor/claim', {});
    vi.setSystemTime(Date.now() + 31_000);
    expect((await as('b', 'POST', '/api/editor/claim', {})).statusCode).toBe(200);
    await as('b', 'POST', '/api/editor/release');
    expect((await as('a', 'GET', '/api/editor')).json().editor).toBeNull();
  });
  it('streams changed and editor events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as any).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = async (needle: string) => { while (!text.includes(needle)) text += dec.decode((await reader.read()).value); };
    await until('event: editor');
    await as('a', 'POST', '/api/modules', { name: 'M' });
    await until('event: changed');
    expect(text).toContain('"by":"a"');
    ac.abort();
  });
});
