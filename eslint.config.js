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
    // PVE web-UI injection script: plain ES5 that must match Proxmox's compiled
    // ExtJS bundle (var, function expressions, string concat, 4-space indent,
    // semicolons). It is browser code loaded by pveproxy, not part of the
    // Node/Vue codebase, so the repo's TS/modern-JS style rules do not apply.
    'packages/pve-integration/anas.js',
  ],
  rules: {
    // Node globals are fine — both processes run on Node.js
    'node/prefer-global/buffer': 'off',
    'node/prefer-global/process': 'off',
    // Zod idiom: export const Foo = z.object(...); export type Foo = z.infer<typeof Foo>
    // The value and type namespaces don't conflict in TypeScript
    'ts/no-redeclare': 'off',
  },
})
