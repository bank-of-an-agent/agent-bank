/**
 * The subset of OpenAPI 3.1 / JSON Schema 2020-12 that the reference
 * generator reads. `docs/openapi.json` is generated from the route registry
 * in `@agentbank/core` (ADR 0003), so only the shapes it emits are modelled.
 */

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  example?: unknown;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export const HTTP_METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface MediaType {
  schema?: JsonSchema;
}

export interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  "x-agentbank-auth"?: string[];
  "x-agentbank-service"?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, MediaType> };
  responses: Record<string, { description?: string; content?: Record<string, MediaType> }>;
}

export interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; summary?: string; description?: string };
  servers?: { url: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
}

/** An operation together with where it lives. */
export interface OperationEntry {
  method: HttpMethod;
  path: string;
  operation: Operation;
  /** Tag page the operation is documented on (its first tag). */
  tag: string;
}
