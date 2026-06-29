import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**',
        'src/types.ts',
        'src/version.ts',
        // cli.ts main() is behind the entrypoint guard and not exercised in tests;
        // parseArgs and parseArgs-related branches ARE covered.
      ],
      thresholds: {
        // Thresholds set ~2-4 points below measured values (ratchet, not over-tight).
        // Measured on 2026-06-29: statements=91.9, branches=82.96, functions=93.18, lines=94.3
        statements: 88,
        branches: 79,
        functions: 91,
        lines: 91,
      },
    },
  },
})
