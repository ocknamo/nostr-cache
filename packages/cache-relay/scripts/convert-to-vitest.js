#!/usr/bin/env node

/**
 * JestからVitestへのテストファイル変換スクリプト
 * 使用方法: node scripts/convert-to-vitest.js
 */

import { exec } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '../src');

// ファイル変換関数
async function convertFile(filePath) {
  try {
    console.log(`Converting: ${filePath}`);
    let content = readFileSync(filePath, 'utf8');

    // Jestのインポートを Vitest に置き換え
    if (!content.includes('import { describe, it, expect')) {
      content = content.replace(
        /(import.*?from.*?['"].*?['"];?\n)/,
        `$1import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi, type Mock } from 'vitest';\n`
      );
    }

    // Jest モックを Vitest モックに置き換え
    content = content.replace(/jest\.fn\(/g, 'vi.fn(');
    content = content.replace(/jest\.spyOn\(/g, 'vi.spyOn(');
    content = content.replace(/jest\.mock\(/g, 'vi.mock(');
    content = content.replace(/jest\.clearAllMocks\(/g, 'vi.clearAllMocks(');
    content = content.replace(/jest\.resetAllMocks\(/g, 'vi.resetAllMocks(');
    content = content.replace(/jest\.restoreAllMocks\(/g, 'vi.restoreAllMocks(');

    // jest.Mocked<T> を Mock<T> に置き換え
    content = content.replace(/jest\.Mocked<([^>]+)>/g, 'Mock<$1>');

    // 型アサーションの修正 (jest.Mockedを使わない場合)
    content = content.replace(/as jest\.Mock(\w*)</g, 'as Mock<');

    writeFileSync(filePath, content, 'utf8');
    console.log(`Successfully converted: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`Error converting ${filePath}:`, error);
    return false;
  }
}

// メイン関数
async function main() {
  try {
    // spec.ts ファイルを検索
    const { stdout } = await execAsync(`find ${srcDir} -name "*.spec.ts"`);
    const files = stdout.trim().split('\n');

    console.log(`Found ${files.length} test files to convert.`);

    // 各ファイルを変換
    const results = await Promise.all(files.map(convertFile));
    const successCount = results.filter(Boolean).length;

    console.log(
      `\nConversion complete: ${successCount}/${files.length} files converted successfully.`
    );
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
