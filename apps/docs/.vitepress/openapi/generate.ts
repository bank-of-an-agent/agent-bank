import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERATED_NOTICE, renderReference, type RenderedReference } from "./render";
import type { OpenApiDocument } from "./types";

/**
 * Writes the API reference pages into the docs source directory when the
 * VitePress config is loaded (dev and build), so they are always generated
 * from the current `docs/openapi.json`: the config imports the document,
 * which makes VitePress restart the dev server when it changes.
 *
 * Generated files are git-ignored (`apps/docs/.gitignore`) and formatted with
 * the repository's Prettier, so `pnpm format:check` stays clean even after a
 * local build. Stale generated pages (a removed tag) are deleted.
 */

export interface GenerateOptions {
  /** The docs source directory (VitePress `srcDir`). */
  srcDir: string;
  /** Folder for the reference, relative to `srcDir`. */
  dir: string;
  /** Format Markdown (Prettier) before writing; identity when unavailable. */
  format?: (markdown: string, filepath: string) => Promise<string>;
}

export async function generateApiReference(
  doc: OpenApiDocument,
  options: GenerateOptions,
): Promise<RenderedReference["sidebar"]> {
  const rendered = renderReference(doc, options.dir);
  const outDir = join(options.srcDir, options.dir);
  mkdirSync(outDir, { recursive: true });

  const wanted = new Set<string>();
  for (const page of rendered.pages) {
    const file = join(options.srcDir, page.file);
    wanted.add(file);
    const content = options.format ? await options.format(page.content, file) : page.content;
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (current !== content) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }

  // Remove generated pages that no longer correspond to a tag.
  for (const name of readdirSync(outDir)) {
    const file = join(outDir, name);
    if (!name.endsWith(".md") || wanted.has(file)) continue;
    if (readFileSync(file, "utf8").slice(0, 400).includes(GENERATED_NOTICE)) rmSync(file);
  }

  return rendered.sidebar;
}

/**
 * A formatter backed by the repository's Prettier (a root dev dependency),
 * resolved lazily so the docs still build if it is missing.
 */
export async function prettierFormatter(): Promise<GenerateOptions["format"]> {
  try {
    const prettier = await import("prettier");
    return async (markdown, filepath) => {
      const config = (await prettier.resolveConfig(filepath)) ?? {};
      return prettier.format(markdown, { ...config, filepath, parser: "markdown" });
    };
  } catch {
    return undefined;
  }
}
