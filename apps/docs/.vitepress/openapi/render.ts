import {
  cell,
  code,
  describe,
  fieldTable,
  flattenFields,
  kebab,
  refName,
  typeLabel,
  unwrapNullable,
  type Linker,
} from "./schema";
import {
  HTTP_METHODS,
  type JsonSchema,
  type OpenApiDocument,
  type Operation,
  type OperationEntry,
  type Parameter,
} from "./types";

/**
 * Renders the API reference pages from the OpenAPI document: one page per
 * tag (every operation with its parameters, request body and response), a
 * schemas page, and an operation index included by the hand-written overview.
 */

export const GENERATED_NOTICE =
  "<!-- Generated from docs/openapi.json by apps/docs/.vitepress/openapi. Do not edit: run the docs build. -->";

/** Generated pages have no source file to edit and only operations in the outline. */
const FRONTMATTER = "---\neditLink: false\noutline: 2\n---";

/** Sidebar groups for the tag pages. Tags not listed here appear under "Other". */
export const TAG_GROUPS: readonly { text: string; tags: readonly string[] }[] = [
  { text: "Identity", tags: ["Orgs", "Agents", "Accounts", "Sessions", "Owner operations"] },
  { text: "Authority", tags: ["Policies", "Mandates", "Approvals"] },
  { text: "Money movement", tags: ["Payments", "x402", "Escrow", "Streams"] },
  { text: "Ledger and savings", tags: ["Ledger", "Savings", "Treasury"] },
  { text: "Platform", tags: ["Webhooks", "Billing", "Meta", "Admin"] },
];

const RESERVED_SLUGS = new Set(["index", "schemas", "_operations"]);

/** File name (without `.md`) of a tag page. */
export function tagSlug(tag: string): string {
  const slug = kebab(tag) || "other";
  return RESERVED_SLUGS.has(slug) ? `${slug}-tag` : slug;
}

/** Anchor of an operation on its tag page. */
export function operationAnchor(operationId: string): string {
  return kebab(operationId);
}

/** Anchor of a schema on the schemas page. */
export function schemaAnchor(name: string): string {
  return kebab(name);
}

/** Every operation, in document order, assigned to its first tag. */
export function collectOperations(doc: OpenApiDocument): OperationEntry[] {
  const out: OperationEntry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    // Document order within a path item follows the route registry.
    for (const [key, operation] of Object.entries(item)) {
      const method = HTTP_METHODS.find((m) => m === key);
      if (!method || !operation) continue;
      out.push({ method, path, operation, tag: operation.tags?.[0] ?? "Other" });
    }
  }
  return out;
}

/** Tags in document order (declared tags first, then any others used by operations). */
export function orderedTags(doc: OpenApiDocument, ops: OperationEntry[]): string[] {
  const tags = (doc.tags ?? []).map((t) => t.name);
  for (const op of ops) for (const t of op.operation.tags ?? [op.tag]) if (!tags.includes(t)) tags.push(t);
  return tags.filter((t) => ops.some((op) => (op.operation.tags ?? [op.tag]).includes(t)));
}

const AUTH_LABELS: Record<string, string> = {
  public: "public (no credentials)",
  principal: "principal: org API key (`Authorization: Bearer abk_…`) or console session",
  agent: "agent: RFC 9421 signature by the session key ([request signing](/guides/request-signing))",
  approver: "approver: a member with the approver or admin role",
  seller: "seller: an x402 seller calling the facilitator",
  staff: "staff: Agent Bank operator token (internal)",
};

const STATUS_TEXT: Record<string, string> = {
  "200": "200 OK",
  "201": "201 Created",
  "202": "202 Accepted",
  "204": "204 No Content",
};

function methodBadge(method: string, path: string): string {
  const m = method.toUpperCase();
  return `<div class="ab-op"><span class="ab-op-method ab-op-${method}">${m}</span><code>${path}</code></div>`;
}

function authOf(op: Operation): string[] {
  return op["x-agentbank-auth"] ?? [];
}

function isIdempotent(op: Operation): boolean {
  return (op.parameters ?? []).some((p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key");
}

function jsonSchemaOf(content: Record<string, { schema?: JsonSchema }> | undefined): JsonSchema | undefined {
  return content?.["application/json"]?.schema;
}

/** Follow one `$ref` to the component schema it names. */
function resolve(doc: OpenApiDocument, schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema?.$ref) return schema;
  return doc.components?.schemas?.[refName(schema.$ref)];
}

/** `{ data: X[], next_cursor }` pages render as "a page of X". */
function pageItem(schema: JsonSchema | undefined): JsonSchema | undefined {
  const props = schema?.properties;
  if (!props || !props.data || !props.next_cursor) return undefined;
  if (Object.keys(props).length !== 2) return undefined;
  return props.data.type === "array" ? props.data.items : undefined;
}

function sdkCall(op: Operation, hasBody: boolean): string {
  const params = op.parameters ?? [];
  const hasPath = params.some((p) => p.in === "path");
  const hasQuery = params.some((p) => p.in === "query");
  const ts = [hasPath ? "params" : "", hasQuery ? "query" : "", hasBody ? "body" : ""].filter(Boolean);
  const py = [
    hasPath ? 'path_params={"id": ...}' : "",
    hasQuery ? "query={...}" : "",
    hasBody ? "body={...}" : "",
  ].filter(Boolean);
  const tsArgs = ts.length > 0 ? `, { ${ts.join(", ")} }` : "";
  const pyArgs = py.length > 0 ? `, ${py.join(", ")}` : "";
  return `TypeScript \`client.request("${op.operationId}"${tsArgs})\` · Python \`client.call("${op.operationId}"${pyArgs})\``;
}

function parameterTable(params: Parameter[], link: Linker): string {
  const lines = ["| Name | In | Type | Required | Description |", "| --- | --- | --- | --- | --- |"];
  for (const p of params) {
    const schema = p.schema ?? {};
    const description = p.description
      ? cell([p.description, ...describe({ ...schema, description: undefined }).split(/(?<=\.) /)].join(" "))
      : describe(schema);
    lines.push(
      `| \`${p.name}\` | ${p.in} | ${typeLabel(schema, link)} | ${p.required ? "yes" : "no"} | ${description} |`,
    );
  }
  return lines.join("\n");
}

function renderResponse(doc: OpenApiDocument, op: Operation, link: Linker): string[] {
  const lines: string[] = [];
  for (const [status, response] of Object.entries(op.responses)) {
    if (status === "default") continue;
    const schema = jsonSchemaOf(response.content);
    const label = STATUS_TEXT[status] ?? status;
    const resolved = resolve(doc, schema);
    const item = pageItem(resolved);
    let what: string;
    if (item) {
      what = `a page of ${typeLabel(item, link)}: \`{ data, next_cursor }\`. Pass \`next_cursor\` back as \`cursor\` for the next page.`;
    } else if (schema?.$ref && resolved && (resolved.anyOf || resolved.oneOf)) {
      what = `${typeLabel(resolved, link)}.`;
    } else if (schema) {
      what = `${typeLabel(schema, link)}.`;
    } else {
      what = "no body.";
    }
    lines.push(`\`${label}\` with ${what}`);
    const others = Object.keys(response.content ?? {}).filter((t) => t !== "application/json");
    if (others.length > 0)
      lines.push("", `Also available as ${others.map((t) => `\`${t}\``).join(", ")} (see the parameters).`);
  }
  lines.push(
    "",
    "Errors are [RFC 9457 problem details](/guides/idempotency-and-errors#error-codes) (`application/problem+json`, schema [Problem](" +
      link("Problem") +
      ")).",
  );
  return lines;
}

function renderOperation(doc: OpenApiDocument, entry: OperationEntry, link: Linker): string {
  const { operation: op, method, path } = entry;
  const title = op.summary ?? op.operationId;
  const lines: string[] = [
    `## ${cell(title)} {#${operationAnchor(op.operationId)}}`,
    "",
    methodBadge(method, path),
    "",
  ];
  if (op.description) lines.push(cell(op.description), "");

  const facts: string[] = [];
  const auth = authOf(op);
  if (auth.length > 0) facts.push(`**Auth:** ${auth.map((a) => AUTH_LABELS[a] ?? a).join("; or ")}`);
  if (isIdempotent(op))
    facts.push(
      "**Idempotent:** send an `Idempotency-Key` header ([idempotency](/guides/idempotency-and-errors#idempotency))",
    );
  if (op["x-agentbank-service"] === "facilitator")
    facts.push("**Served by:** the x402 facilitator (`/v1/x402/*` is routed there)");
  const body = jsonSchemaOf(op.requestBody?.content);
  facts.push(`**Operation id:** \`${op.operationId}\``);
  facts.push(`**SDKs:** ${sdkCall(op, body !== undefined)}`);
  lines.push(...facts.map((f) => `- ${f}`), "");

  const params = op.parameters ?? [];
  if (params.length > 0) lines.push("### Parameters", "", parameterTable(params, link), "");

  if (body) {
    const resolved = resolve(doc, body) ?? {};
    const name = body.$ref ? refName(body.$ref) : undefined;
    lines.push("### Request body", "");
    lines.push(
      name
        ? `\`application/json\`, schema [${name}](${link(name)}).`
        : `\`application/json\`: ${typeLabel(body, link)}.`,
      "",
    );
    const rows = flattenFields(resolved, link);
    if (rows.length > 0) lines.push(fieldTable(rows), "");
  }

  lines.push("### Response", "", ...renderResponse(doc, op, link), "");
  return lines.join("\n");
}

export interface RenderedPage {
  /** Path relative to the docs source directory, e.g. `api/payments.md`. */
  file: string;
  content: string;
}

export interface RenderedReference {
  pages: RenderedPage[];
  /** Tag pages in sidebar order, grouped. */
  sidebar: { text: string; items: { text: string; link: string }[] }[];
}

/** Render every page of the API reference. `dir` is the output folder (`api`). */
export function renderReference(doc: OpenApiDocument, dir: string): RenderedReference {
  const ops = collectOperations(doc);
  const tags = orderedTags(doc, ops);
  const fromTagPage: Linker = (name) => `./schemas#${schemaAnchor(name)}`;
  const fromSchemasPage: Linker = (name) => `#${schemaAnchor(name)}`;
  const pages: RenderedPage[] = [];

  for (const tag of tags) {
    const primary = ops.filter((o) => o.tag === tag);
    const secondary = ops.filter((o) => o.tag !== tag && (o.operation.tags ?? []).includes(tag));
    const lines: string[] = [FRONTMATTER, "", GENERATED_NOTICE, "", `# ${cell(tag)}`, ""];
    const description = doc.tags?.find((t) => t.name === tag)?.description;
    if (description) lines.push(cell(description), "");
    lines.push("| Operation | Endpoint | Auth |", "| --- | --- | --- |");
    for (const o of [...primary, ...secondary]) {
      const href =
        o.tag === tag
          ? `#${operationAnchor(o.operation.operationId)}`
          : `./${tagSlug(o.tag)}#${operationAnchor(o.operation.operationId)}`;
      lines.push(
        `| [${cell(o.operation.summary ?? o.operation.operationId)}](${href}) | \`${o.method.toUpperCase()} ${o.path}\` | ${authOf(o.operation).join(", ")} |`,
      );
    }
    lines.push("");
    for (const o of primary) lines.push(renderOperation(doc, o, fromTagPage));
    pages.push({ file: `${dir}/${tagSlug(tag)}.md`, content: `${lines.join("\n").trimEnd()}\n` });
  }

  pages.push({ file: `${dir}/schemas.md`, content: renderSchemas(doc, ops, fromSchemasPage) });
  pages.push({ file: `${dir}/_operations.md`, content: renderOperationIndex(ops, tags) });

  const grouped = new Set<string>();
  const sidebar = TAG_GROUPS.map((group) => {
    const items = group.tags
      .filter((t) => tags.includes(t))
      .map((t) => {
        grouped.add(t);
        return { text: t, link: `/${dir}/${tagSlug(t)}` };
      });
    return { text: group.text, items };
  }).filter((g) => g.items.length > 0);
  const rest = tags.filter((t) => !grouped.has(t));
  if (rest.length > 0)
    sidebar.push({ text: "Other", items: rest.map((t) => ({ text: t, link: `/${dir}/${tagSlug(t)}` })) });
  return { pages, sidebar };
}

/** Which operations use each schema directly (request body or success response). */
function usages(ops: OperationEntry[]): Map<string, OperationEntry[]> {
  const out = new Map<string, OperationEntry[]>();
  const note = (schema: JsonSchema | undefined, entry: OperationEntry) => {
    if (!schema?.$ref) return;
    const name = refName(schema.$ref);
    const list = out.get(name) ?? [];
    if (!list.includes(entry)) list.push(entry);
    out.set(name, list);
  };
  for (const entry of ops) {
    note(jsonSchemaOf(entry.operation.requestBody?.content), entry);
    for (const [status, response] of Object.entries(entry.operation.responses)) {
      if (status !== "default") note(jsonSchemaOf(response.content), entry);
    }
  }
  return out;
}

function renderSchemas(doc: OpenApiDocument, ops: OperationEntry[], link: Linker): string {
  const schemas = doc.components?.schemas ?? {};
  const used = usages(ops);
  const names = Object.keys(schemas).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [
    FRONTMATTER,
    "",
    GENERATED_NOTICE,
    "",
    "# Schemas",
    "",
    "Every named schema of the API contract, generated from `docs/openapi.json`. Money is a decimal string plus an asset code, ids are prefixed, timestamps are ISO 8601 and fields are `snake_case`.",
    "",
  ];
  for (const name of names) {
    const schema = schemas[name] ?? {};
    lines.push(`## ${name} {#${schemaAnchor(name)}}`, "");
    if (schema.description) lines.push(cell(schema.description), "");
    const { variants, nullable } = unwrapNullable(schema);
    const only = variants.length === 1 ? variants[0] : undefined;
    if (only?.properties && !only.$ref && !nullable) {
      lines.push(fieldTable(flattenFields(only, link)), "");
    } else {
      lines.push(`Type: ${typeLabel(schema, link)}.`, "");
    }
    const users = used.get(name) ?? [];
    if (users.length > 0) {
      const refs = users.map(
        (u) =>
          `[\`${u.operation.operationId}\`](./${tagSlug(u.tag)}#${operationAnchor(u.operation.operationId)})`,
      );
      lines.push(`Used by ${refs.join(", ")}.`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderOperationIndex(ops: OperationEntry[], tags: string[]): string {
  const lines: string[] = [GENERATED_NOTICE, ""];
  for (const tag of tags) {
    const list = ops.filter((o) => o.tag === tag);
    if (list.length === 0) continue;
    lines.push(
      `### ${cell(tag)}`,
      "",
      "| Endpoint | Summary | Auth | Idempotency key |",
      "| --- | --- | --- | --- |",
    );
    for (const o of list) {
      const href = `./${tagSlug(tag)}#${operationAnchor(o.operation.operationId)}`;
      const idempotent = isIdempotent(o.operation) ? "required" : "";
      lines.push(
        `| [\`${o.method.toUpperCase()} ${o.path}\`](${href}) | ${cell(o.operation.summary ?? "")} | ${authOf(o.operation).join(", ")} | ${idempotent} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A short code span for a JSON value (re-exported for the overview page helpers). */
export { code };
