export class ApiError extends Error {}

export type Fetch = typeof fetch;

export class PlannerApi {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private fetchImpl: Fetch = fetch,
    private project?: string,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-agent": "mcp",
        ...(this.project ? { "x-project": this.project } : {}),
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        err ? `${err.code ?? res.status}: ${err.message ?? ""}` : `HTTP ${res.status} ${res.statusText}`,
      );
    }
    return data as T;
  }
}
