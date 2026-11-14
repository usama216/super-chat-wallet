// unit: pure functions, no database.
// integration: the real app against Postgres. Idempotency and double-spend protection come
// from Postgres locks/constraints, so they're tested against a real database.
const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
};

module.exports = {
  testTimeout: 30000,
  // integration files share one test database and reset it, so run files one at a time
  // (concurrency is tested inside each test)
  maxWorkers: 1,
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    { ...base, displayName: 'integration', testMatch: ['<rootDir>/test/**/*.int-spec.ts'] },
  ],
};
