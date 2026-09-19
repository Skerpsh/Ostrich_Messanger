import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      login_id: string;
      username: string;
      created_at: Date;
    };
  }
}
