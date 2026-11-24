// ESLint flat config (ESLint 9+ removed .eslintrc support). Same rules as the
// old .eslintrc.json: eslint:recommended + typescript-eslint recommended, Node
// globals (Jest globals in __tests__/ only), two rules relaxed to warnings.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Bundled and compiled output, for `npx eslint .` and editor integrations.
  // `npm run lint` itself only covers src/ and __tests__/.
  { ignores: ['dist/', 'coverage/', 'azure-devops/dist/', 'azure-devops/out/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // Jest globals only where Jest runs. (typescript-eslint turns no-undef off
  // for .ts files, so this documents intent; tsc does the undefined checks.)
  {
    files: ['__tests__/**'],
    languageOptions: {
      globals: globals.jest,
    },
  }
);
