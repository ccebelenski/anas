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
    // PVE web-UI injection scripts: plain ES5 that must match Proxmox's
    // compiled ExtJS bundle (var, function expressions, string concat, 4-space
    // indent, semicolons). These are browser code loaded by pveproxy — the
    // per-view sources in src/ plus the generated anas.js — not part of the
    // Node/Vue codebase, so the repo's TS/modern-JS style rules do not apply.
    'packages/pve-integration/**/*.js',
    // Render harnesses for those same ES5 sources: standalone node scripts
    // whose console output IS the test report (run directly, not via the test
    // runner) — product-code style rules (no-console etc.) do not apply.
    'packages/pve-integration/test/*.harness.mjs',
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
