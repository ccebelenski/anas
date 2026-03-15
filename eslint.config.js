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
