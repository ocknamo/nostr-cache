import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

// ESLint here is scoped to `.svelte` files only: biome (`lint:check`) already
// lints every `.ts` file in the monorepo, but it cannot parse Svelte templates.
// eslint-plugin-svelte fills that gap (unused markup vars, a11y-adjacent checks,
// reactive-scope mistakes) without taking over the TypeScript linting.
export default ts.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte'],
    languageOptions: {
      // Parse the `<script lang="ts">` blocks with the TypeScript ESLint parser.
      parserOptions: {
        parser: ts.parser,
      },
      globals: {
        ...globals.browser,
      },
    },
  }
);
