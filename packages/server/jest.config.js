/**
 * Jest configuration for server package
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup-jest.ts'],
  moduleNameMapper: {
    '@nostr-cache/([^/]*)': '<rootDir>/../$1/src',
    '@nostr-cache/cache-relay/dist/(.*)': '<rootDir>/../cache-relay/src/$1',
  },
  testTimeout: 10000,
};
