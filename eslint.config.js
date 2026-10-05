import { builtinModules } from "node:module";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Node's built-in modules, written without `node:` (`fs`, `path`…); `node:*` is banned by pattern. */
function bannedBuiltins(message) {
  return builtinModules.map((name) => ({ name, message }));
}

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/drizzle/**", "**/out/**", "**/dist/**", ".superpowers/**"] },
  ...tseslint.configs.strictTypeChecked,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // A new event type or state must be handled everywhere it is switched on (an explicit `default` is a choice).
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // Shared code also runs in the sandboxed pages, and the pages have neither Node nor Electron.
    files: ["apps/desktop/src/shared/**", "apps/desktop/src/renderer/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "electron", message: "Pages and shared code cannot use Electron: go through window.alicia." },
          ...bannedBuiltins("Pages and shared code cannot use Node modules."),
        ],
        patterns: [{ group: ["node:*"], message: "Pages and shared code cannot use Node modules." }],
      }],
    },
  },
  {
    // The preload runs sandboxed: only Electron's renderer modules, no Node modules.
    files: ["apps/desktop/src/preload/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: bannedBuiltins("The sandboxed preload cannot use Node modules."),
        patterns: [{ group: ["node:*"], message: "The sandboxed preload cannot use Node modules." }],
      }],
    },
  },
  {
    // Shared code also runs in the main process, which has no DOM.
    files: ["apps/desktop/src/shared/**"],
    rules: {
      "no-restricted-globals": ["error",
        { name: "window", message: "Shared code also runs in the main process, which has no window." },
        { name: "document", message: "Shared code also runs in the main process, which has no document." },
      ],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
