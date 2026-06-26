/**
 * Vitest setup file for the shared package.
 * Suppresses info/debug log output during tests, mirroring cache-relay.
 */

import { beforeAll } from 'vitest';
import { logger } from '../utils/logger.js';

beforeAll(() => {
  logger.setTestEnvironment(true);
});
