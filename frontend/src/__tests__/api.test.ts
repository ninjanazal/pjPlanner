import { api, ApiError } from '../api';

const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('GETs the graph', async () => {
    const f = mockFetch(200, { modules: [], owners: [], relations: [] });
    expect(await api.getGraph()).toEqual({ modules: [], owners: [], relations: [] });
    expect(f.mock.calls[0][0]).toBe('/api/graph');
  });
  it('POSTs JSON bodies', async () => {
    const f = mockFetch(201, { id: 1 });
    await api.createModule({ name: 'a' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/modules');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"a"}');
  });
  it('PUTs a module position', async () => {
    const f = mockFetch(200, { id: 3 });
    await api.setPosition(3, { x: 10, y: 20 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/modules/3/position');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"x":10,"y":20}');
  });
  it('PUTs a batch of positions', async () => {
    const f = mockFetch(200, []);
    await api.setPositions([{ id: 1, x: 2, y: 3 }]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/modules/positions');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"positions":[{"id":1,"x":2,"y":3}]}');
  });
  it('handles 204', async () => {
    mockFetch(204);
    await expect(api.deleteModule(1)).resolves.toBeUndefined();
  });
  it('throws ApiError with server message', async () => {
    mockFetch(409, { error: { code: 'conflict', message: 'Owner name already exists' } });
    const err = await api.createOwner({ name: 'a', color: null, icon: null }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Owner name already exists');
  });
});
