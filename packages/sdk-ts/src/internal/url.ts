/** Join a base URL (which may carry a path prefix) and an absolute API path. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Fill `{name}` placeholders of a route path from `params` (URL-encoding each
 * value). Calls `onMissing` (which must throw) for the first missing parameter.
 */
export function fillPath(
  path: string,
  params: Record<string, unknown> | undefined,
  onMissing: (name: string) => never,
): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === "") onMissing(name);
    return encodeURIComponent(String(value));
  });
}

/**
 * Append query parameters: `undefined`/`null` are skipped, arrays repeat the
 * key, everything else is stringified.
 */
export function appendQuery(url: URL, query: Record<string, unknown> | undefined): URL {
  if (!query) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value)
        if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url;
}
