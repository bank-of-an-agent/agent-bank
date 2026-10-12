import { z } from "zod";
import { Problem } from "./resources";
import { WEBHOOK_EVENT_TYPES } from "../webhooks";
import { ROUTE_LIST, type AuthKind, type RouteDef } from "./routes";

/**
 * Builds the OpenAPI 3.1 document from the route registry. OpenAPI 3.1 uses
 * JSON Schema 2020-12, which is what Zod emits, so components are generated
 * directly from the registered Zod schemas.
 */

export const API_VERSION = "0.1.0";

type JsonObject = Record<string, unknown>;

const SECURITY_SCHEMES: Record<string, JsonObject> = {
  apiKey: {
    type: "http",
    scheme: "bearer",
    description:
      "Org API key (`abk_test_…`). Principals only. Create keys in the console or with `POST /v1/api-keys`.",
  },
  sessionSignature: {
    type: "apiKey",
    in: "header",
    name: "Signature",
    description:
      "HTTP Message Signature (RFC 9421) by the agent's session key. Send `Signature-Input` and `Signature` (label `agentbank`, alg `eip191-secp256k1`, keyid = session id) plus `Content-Digest` for bodies. The SDKs do this for you.",
  },
  staffToken: { type: "http", scheme: "bearer", description: "Agent Bank operator token (internal)." },
};

const AUTH_TO_SECURITY: Record<AuthKind, JsonObject[]> = {
  public: [{}],
  principal: [{ apiKey: [] }],
  agent: [{ sessionSignature: [] }],
  approver: [{ apiKey: [] }],
  seller: [{}],
  staff: [{ staffToken: [] }],
};

function pascal(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ensureRegistered(schema: z.ZodType, fallbackId: string): string {
  const existing = z.globalRegistry.get(schema)?.id;
  if (typeof existing === "string") return existing;
  z.globalRegistry.add(schema, { id: fallbackId });
  return fallbackId;
}

function ref(id: string): JsonObject {
  return { $ref: `#/components/schemas/${id}` };
}

function stripMeta(schema: JsonObject): JsonObject {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}

function parametersFor(objectSchema: z.ZodObject | undefined, location: "query" | "path"): JsonObject[] {
  if (!objectSchema) return [];
  const json = z.toJSONSchema(objectSchema, { io: "input", unrepresentable: "any" }) as JsonObject;
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: location,
    required: location === "path" ? true : required.has(name),
    schema,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
  }));
}

export interface OpenApiOptions {
  serverUrls?: string[];
  service?: "api" | "facilitator" | "all";
}

export function buildOpenApiDocument(options: OpenApiOptions = {}): JsonObject {
  const service = options.service ?? "all";
  const selected = ROUTE_LIST.filter((r) => service === "all" || (r.service ?? "api") === service);

  const operationRefs = new Map<RouteDef, { body?: string; response: string }>();
  for (const route of selected) {
    const base = pascal(route.operationId);
    operationRefs.set(route, {
      ...(route.body ? { body: ensureRegistered(route.body, `${base}Body`) } : {}),
      response: ensureRegistered(route.response, `${base}Response`),
    });
  }
  ensureRegistered(Problem, "Problem");

  const generated = z.toJSONSchema(z.globalRegistry, {
    uri: (id) => `#/components/schemas/${id}`,
    io: "input",
    unrepresentable: "any",
  });
  const schemas: Record<string, JsonObject> = {};
  for (const [id, schema] of Object.entries(generated.schemas)) schemas[id] = stripMeta(schema as JsonObject);

  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const route of selected) {
    const refs = operationRefs.get(route);
    if (!refs) continue;
    const parameters = [...parametersFor(route.params, "path"), ...parametersFor(route.query, "query")];
    if (route.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Unique key per logical operation. Retries with the same key return the original result.",
        schema: { type: "string", minLength: 8, maxLength: 255 },
      });
    }
    const status = String(route.status ?? 200);
    const content: JsonObject = { "application/json": { schema: ref(refs.response) } };
    for (const mediaType of route.produces ?? []) content[mediaType] = { schema: { type: "string" } };

    const operation: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      tags: [...route.tags],
      security: route.auth.flatMap((a) => AUTH_TO_SECURITY[a]),
      "x-agentbank-auth": [...route.auth],
      ...(route.service && route.service !== "api" ? { "x-agentbank-service": route.service } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(refs.body
        ? { requestBody: { required: true, content: { "application/json": { schema: ref(refs.body) } } } }
        : {}),
      responses: {
        [status]: { description: "Success", content },
        default: {
          description: "Error (RFC 9457 problem details)",
          content: { "application/problem+json": { schema: ref("Problem") } },
        },
      },
    };
    const pathItem = (paths[route.path] ??= {});
    pathItem[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Bank API",
      version: API_VERSION,
      summary: "Programmable, non-custodial bank accounts for AI agents.",
      description:
        "Money is a decimal string plus an asset code. Ids are prefixed (`org_`, `agt_`, `acct_`, `pay_`, `esc_`). Every write takes an `Idempotency-Key`. Errors follow RFC 9457. Testnet (Base Sepolia) only.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: (options.serverUrls ?? ["http://localhost:8080"]).map((url) => ({ url })),
    tags: [...new Set(selected.flatMap((r) => r.tags))].map((name) => ({ name })),
    paths,
    webhooks: Object.fromEntries(
      WEBHOOK_EVENT_TYPES.map((type) => [
        type,
        {
          post: {
            summary: `${type} event`,
            description:
              "Delivered as JSON with headers AgentBank-Signature (t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>), AgentBank-Event and AgentBank-Delivery. Retried with backoff for 72 hours until a 2xx response.",
            requestBody: { required: true, content: { "application/json": { schema: ref("Event") } } },
            responses: { "200": { description: "Acknowledged" } },
          },
        },
      ]),
    ),
    components: { schemas, securitySchemes: SECURITY_SCHEMES },
  };
}
