import { IntegrationTestBase } from './base.integration';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi, type Mock } from 'vitest';

/**
 * Simple test to prevent "empty test suite" error
 */
describe('Base Integration Setup', () => {
  it('should create and setup test environment', async () => {
    const testBase = new IntegrationTestBase();
    const port = await testBase.setup();
    expect(port).toBeGreaterThan(0);
    expect(testBase.getServerUrl()).toMatch(/^ws:\/\/localhost:\d+$/);
    await testBase.teardown();
  });
});
