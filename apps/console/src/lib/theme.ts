/** Theme preference: "system" follows `prefers-color-scheme`; stored per browser. */

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "agentbank.theme";

/**
 * Runs before first paint (inline, with the CSP nonce) so the page never
 * flashes the wrong theme. Kept tiny and dependency-free.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");if(p!=="light"&&p!=="dark")p="system";var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;var d=document.documentElement;d.setAttribute("data-theme",t);d.setAttribute("data-theme-preference",p);}catch(e){}})();`;

export function readPreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  const value = document.documentElement.getAttribute("data-theme-preference");
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== "system") return preference;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(preference));
  root.setAttribute("data-theme-preference", preference);
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage may be blocked; the choice still applies to this page.
  }
}
