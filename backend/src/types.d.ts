import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      username: string;
      created_at: Date;
      username_changed_at: Date | null;
      avatar_id: string | null;
      is_developer: boolean;
      show_presence: boolean;
      read_receipts: boolean;
    };
    token: string;
  }
}
