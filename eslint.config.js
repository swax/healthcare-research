// Flat config (ESLint 9). Lints the native-TypeScript sources without a
// type-checking pass — matches the project's no-build, erasable-syntax-only setup.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'references/**'] },
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
