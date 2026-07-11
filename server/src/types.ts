import type { FastifyReply, FastifyRequest } from 'fastify';

// name 不在 JWT payload 里签发；authenticate 每请求查库回填（viewer 归属过滤锚，取库中最新，改名即生效）
export interface JwtUser { userId: string; tenantId: string; role: string; name?: string }

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
