import antfu from '@antfu/eslint-config'

export default antfu({
  vue: true,
  typescript: true,
  ignores: [
    '**/dist/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/node_modules/**',
    'docs/**',
    // Captured command output — verbatim fixtures, never reformat
    'packages/daemon/src/fixtures/**/*.json',
    'tests/integration/fixtures/**',
    'playwright-report/**',
  ],
  rules: {
    // Node globals are fine — both processes run on Node.js
    'node/prefer-global/buffer': 'off',
    'node/prefer-global/process': 'off',
    // Zod idiom: export const Foo = z.object(...); export type Foo = z.infer<typeof Foo>
    // The value and type namespaces don't conflict in TypeScript
    'ts/no-redeclare': 'off',
    // This repo uses the node:test runner (tsx --test), not vitest —
    // the auto-fix for this rule rewrites imports to a dependency we don't have
    'test/no-import-node-test': 'off',
  },
})
