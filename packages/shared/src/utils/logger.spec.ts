import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel, Logger, logger } from './logger.js';

describe('Logger', () => {
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;
  let infoSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    // Reset to a known state between tests (logger is a shared singleton).
    logger.setLevel(LogLevel.INFO);
    logger.setTestEnvironment(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the shared singleton's defaults so state does not leak across files.
    logger.setLevel(LogLevel.INFO);
    logger.setTestEnvironment(true);
  });

  it('exposes a singleton instance', () => {
    expect(Logger.getInstance()).toBe(logger);
  });

  it('always logs errors regardless of level', () => {
    logger.setLevel(LogLevel.ERROR);
    logger.error('boom');

    expect(errorSpy).toHaveBeenCalledWith('[ERROR] boom');
  });

  it('suppresses warnings when level is below WARN', () => {
    logger.setLevel(LogLevel.ERROR);
    logger.warn('careful');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits warnings when level is WARN or higher', () => {
    logger.setLevel(LogLevel.WARN);
    logger.warn('careful');

    expect(warnSpy).toHaveBeenCalledWith('[WARN] careful');
  });

  it('emits info logs outside of a test environment', () => {
    logger.info('details', 42);

    expect(infoSpy).toHaveBeenCalledWith('[INFO] details', 42);
  });

  it('suppresses info logs in a test environment', () => {
    logger.setTestEnvironment(true);
    logger.info('details');

    expect(infoSpy).not.toHaveBeenCalled();
  });
});
