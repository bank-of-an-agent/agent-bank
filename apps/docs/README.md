# Agent Bank documentation site

The VitePress site: concepts, guides, framework quickstarts and an API reference generated at
build time from [`docs/openapi.json`](../../docs/openapi.json). Fonts are bundled; the build needs
no network.

```bash
pnpm --filter @agentbank/docs dev       # http://localhost:5173
pnpm --filter @agentbank/docs build     # .vitepress/dist, dead links fail the build
```

Quickstart pages embed code from the runnable packages in [`examples/`](../../examples), so the
docs and the examples cannot drift apart.
