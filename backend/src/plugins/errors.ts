import type { FastifyInstance } from 'fastify';
import { HttpError } from '../errors.js';
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.extra ? { extra: err.extra } : {}) } });
    }
    if (err.statusCode && err.statusCode < 500) {
      const code = err.statusCode === 404 ? 'not_found' : 'validation_error';
      return reply.status(err.statusCode).send({ error: { code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
}
