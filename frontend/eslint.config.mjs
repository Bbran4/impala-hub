import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import hooks from 'eslint-plugin-react-hooks';

// Start with correctness checks across all production code. TypeScript owns
// undefined symbols, redeclarations and types; unused-code/style cleanup is
// separate from this gate so it does not obscure security regression work.
export default [
  { ignores: ['dist/**', 'node_modules/**', '.api-server-test-*/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'api/**/*.ts'],
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': hooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Publication failures are deliberately replaced with a sanitized error.
    files: ['api/marketing/facebook/_publishing.ts'],
    rules: { 'preserve-caught-error': 'off' },
  },
  {
    // The file-name sanitizer deliberately removes ASCII control characters.
    files: ['api/reporting/_reportMail.ts'],
    rules: { 'no-control-regex': 'off' },
  },
];
