import { buildOpenApiDocument } from "@agentbank/core/api";
import type { FastifyInstance } from "fastify";

/**
 * `GET /openapi.json` (the generated OpenAPI 3.1 document for this service) and `GET /docs`,
 * a small self-contained reference page rendered from it. The page loads nothing from a CDN:
 * one inline script fetches /openapi.json and lists operations, auth and schemas.
 */

const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Bank API reference</title>
<style>
:root{color-scheme:light dark;--fg:#1b1f24;--muted:#57606a;--bg:#fff;--card:#f6f8fa;--line:#d0d7de;--accent:#0b6bcb}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8d96a0;--bg:#0d1117;--card:#161b22;--line:#30363d;--accent:#4493f8}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.op{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}
.m{display:inline-block;min-width:56px;font:600 12px ui-monospace,monospace;color:var(--accent)}
code{font:13px ui-monospace,monospace} .muted{color:var(--muted)} details pre{overflow:auto;font-size:12px}
</style></head><body><main>
<h1>Agent Bank API</h1><p class="muted" id="info">Loading /openapi.json…</p><div id="ops"></div>
<script>
fetch("openapi.json").then(r=>r.json()).then(doc=>{
  document.getElementById("info").textContent=doc.info.description+" Version "+doc.info.version+".";
  const byTag={};
  for(const [path,item] of Object.entries(doc.paths)) for(const [method,op] of Object.entries(item)){
    const tag=(op.tags&&op.tags[0])||"Other"; (byTag[tag]=byTag[tag]||[]).push({path,method,op});
  }
  const root=document.getElementById("ops");
  for(const [tag,ops] of Object.entries(byTag)){
    const h=document.createElement("h2"); h.textContent=tag; root.appendChild(h);
    for(const {path,method,op} of ops){
      const d=document.createElement("div"); d.className="op";
      const auth=(op["x-agentbank-auth"]||[]).join(", ");
      d.innerHTML='<span class="m"></span><code></code><div></div><div class="muted"></div>';
      d.children[0].textContent=method.toUpperCase(); d.children[1].textContent=path;
      d.children[2].textContent=op.summary||""; d.children[3].textContent="operationId "+op.operationId+" · auth: "+auth;
      const det=document.createElement("details"); const s=document.createElement("summary"); s.textContent="Schema";
      const pre=document.createElement("pre"); pre.textContent=JSON.stringify({parameters:op.parameters,requestBody:op.requestBody,responses:op.responses},null,2);
      det.append(s,pre); d.appendChild(det); root.appendChild(d);
    }
  }
}).catch(()=>{document.getElementById("info").textContent="Could not load openapi.json";});
</script></main></body></html>`;

export function registerDocs(app: FastifyInstance, serverUrl: string | undefined): void {
  let cached: string | undefined;
  app.get("/openapi.json", async (_request, reply) => {
    cached ??= JSON.stringify(
      buildOpenApiDocument({ service: "api", ...(serverUrl ? { serverUrls: [serverUrl] } : {}) }),
    );
    return reply.header("content-type", "application/json; charset=utf-8").send(cached);
  });
  app.get("/docs", async (_request, reply) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      )
      .send(DOCS_HTML),
  );
}
