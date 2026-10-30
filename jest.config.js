module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // @actions/github 8 pulls in Octokit 7, which ships ESM only. The suite is
  // CommonJS, so those packages (and their tiny ESM-only helpers) are compiled
  // to CJS by ts-jest instead of being skipped as node_modules. This keeps
  // plain `jest` (IDE runners, `npx jest <file>`, --watch) working without a
  // Node flag.
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true, module: 'commonjs', esModuleInterop: true },
        diagnostics: false,
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@octokit|universal-user-agent|before-after-hook|fast-content-type-parse|content-type)/)',
  ],
};
