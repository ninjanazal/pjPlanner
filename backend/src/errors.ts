export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const bad = (m: string) => new HttpError(400, 'validation_error', m);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (m: string, extra?: Record<string, unknown>) => new HttpError(409, 'conflict', m, extra);
