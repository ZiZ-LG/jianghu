import type { FastifyReply, FastifyRequest } from 'fastify';

export interface JwtUser { userId: string; tenantId: string; role: string }

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
