import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** The raw JSON body as received (needed for RFC 9421 Content-Digest verification). */
    rawBody?: string;
  }
  interface FastifyContextConfig {
    /** Operation id of a registry route. */
    operationId?: string;
  }
}
