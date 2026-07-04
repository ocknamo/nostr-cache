/**
 * Resolves how to launch Chromium across environments.
 *
 * In the dev container a Chromium build is preinstalled under
 * PLAYWRIGHT_BROWSERS_PATH but may not match Playwright's expected revision,
 * so we point at it explicitly. In CI, `npx playwright install` provides the
 * matching build and the default launch (no executablePath) is used.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';

/**
 * Return an explicit Chromium executable path if a preinstalled build exists,
 * otherwise undefined (let Playwright use its own managed build).
 */
export function resolveChromiumExecutable(): string | undefined {
  if (process.env.PW_CHROMIUM_EXECUTABLE && existsSync(process.env.PW_CHROMIUM_EXECUTABLE)) {
    return process.env.PW_CHROMIUM_EXECUTABLE;
  }

  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath) {
    const symlinked = join(browsersPath, 'chromium');
    if (existsSync(symlinked)) return symlinked;
  }

  return undefined;
}

/**
 * Launch a headless Chromium instance using the resolved executable.
 */
export function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumExecutable();
  return chromium.launch(executablePath ? { executablePath } : {});
}
