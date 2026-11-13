import { FastifyAdapter } from '@nestjs/platform-fastify';

export function createHttpAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({ trustProxy: false, bodyLimit: 6 * 1024 * 1024 });
  adapter.getInstance().addHook('onRoute', route => {
    if (route.url === '/v1/events') route.bodyLimit = 32 * 1024;
    if (route.url.startsWith('/v1/auth/')) route.bodyLimit = 16 * 1024;
  });
  adapter.getInstance().addHook('onRequest', async (_request, reply) => {
    // Public cacheable responses explicitly override this on their handlers.
    void reply.header('Cache-Control', 'no-store');
  });
  return adapter;
}
