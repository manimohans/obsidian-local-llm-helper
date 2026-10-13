// Based on the official community scanner configuration:
// https://github.com/obsidianmd/eslint-plugin/blob/master/docs/configuration.md
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "manifest.json"],
        },
        extraFileExtensions: [".json"],
      },
    },
  },

  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
    rules: {
      // Preserve product names, acronyms and literal examples in user-facing text.
      "obsidianmd/ui/sentence-case": ["warn", {
        allowAutoFix: true,
        brands: ["PDFs", "WebP", "Obsidian", "Markdown", "OpenAI", "Ollama", "Tavily", "Qwen", "DeepSeek", "Local LLM Helper", "LLM Helper", "LLM Chat", "Vault Radar", "Insight Canvas", "Related Notes", "Vault Actions", "LM Studio", "vLLM", "SearXNG", "Brave Search", "Spanish", "Radar"],
        acronyms: ["AI", "API", "URL", "HTTP", "JSON", "LLM", "PDF", "PNG", "JPG", "GIF", "HTML", "CSS", "ID", "RAG", "OCR", "BMP", "N", "YYYY-MM-DD"],
        ignoreRegex: ["^https?://", "^#", "^not-needed$", "^inherit chat/default key$", "^llama3$", "^mxbai-embed-large$"],
      }],
      // Security — keep as errors
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-forbidden-elements": "error",

      // Covered by TypeScript or too noisy
      "no-undef": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "import/no-unresolved": "off",

      // Scanner handles these separately
      "obsidianmd/validate-manifest": "off",
      "obsidianmd/validate-license": "off",

      // Old plugins should not change their command ids
      "obsidianmd/commands/no-command-in-command-id": "off",
      "obsidianmd/commands/no-plugin-id-in-command-id": "off",
    },
  },

  globalIgnores([
    "node_modules",
    "main.js",
    "dist",
    "build",
    "pkg",
    "test-vault",
    ".obsidian",
    "esbuild.config.mjs",
    "version-bump.mjs",
    "**/*.test.*",
    "**/*.tests.*",
    "**/*.spec.*",
    "**/*.specs.*",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/mocks/**",
    "**/__mocks__/**",
    "**/*.cjs",
    "**/*.mjs",
    "**/*.cts",
    "**/*.mts",
    "**/vite*",
    "**/scripts/**",
    "**/docs/**",
    "**/i18n/**",
    "**/i18next/**",
    "**/locale/**",
    "**/locales/**",
    "**/translations/**",
    "**/l10n/**",
    ".pnpm-store",
    "**/*.spec.ts",
    "**/testUtils**",
    "automation/**",
    "e2e-tests/**",
  ]),
]);
