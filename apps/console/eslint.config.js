import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import rootConfig from "../../eslint.config.js";

/**
 * The monorepo config plus Next.js and React rules for the console.
 * ESLint resolves the nearest config file per linted file, so this one
 * extends the root config instead of replacing it.
 */
export default [
  ...rootConfig,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: import.meta.dirname } },
    rules: {
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // The page CSP has no 'unsafe-inline' for styles in production.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='style']",
          message: "Inline style attributes are blocked by the CSP. Use Tailwind classes or SVG attributes.",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "No raw HTML in the console.",
        },
      ],
      // Money is decimal strings and bigint minor units, never floats.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is decimal strings and bigint minor units. No floats." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Money is never a float." },
        { property: "toFixed", message: "Format money with the helpers in src/lib/money.ts." },
      ],
    },
  },
];
