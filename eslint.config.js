import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Packages that handle money must never touch floating point. */
const MONEY_PACKAGES = ["packages/core/src/**", "packages/ledger/src/**", "packages/policy/src/**"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.vitepress/cache/**",
      "**/.vitepress/dist/**",
      "**/next-env.d.ts",
      "infra/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: MONEY_PACKAGES,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is integer minor units. No floats." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Money is integer minor units. No floats." },
        { property: "toFixed", message: "Money is integer minor units. Use formatAmount()." },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**", "**/scripts/**", "examples/**"],
    rules: { "no-console": "off" },
  },
  prettier,
);
