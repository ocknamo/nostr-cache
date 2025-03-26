/**
 * Simple logging utility for Nostr cache projects
 * Provides log level control and test environment handling
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

export class Logger {
  private static instance: Logger;
  private level: LogLevel = LogLevel.INFO; // デフォルトレベル
  private isTestEnv = false;

  // シングルトンパターン
  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  // ログレベル設定
  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  // テスト環境設定
  public setTestEnvironment(isTest: boolean): void {
    this.isTestEnv = isTest;
  }

  // エラーログ - 常に出力
  public error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }

  // 警告ログ - エラーと警告のみ出力時に表示
  public warn(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  // 情報ログ - テスト時は抑制可能
  public info(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.INFO && !this.isTestEnv) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  // デバッグログ - 詳細情報、テスト時は抑制可能
  public debug(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.DEBUG && !this.isTestEnv) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  // 詳細ログ - 最も詳細な情報、テスト時は抑制可能
  public verbose(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.VERBOSE && !this.isTestEnv) {
      console.log(`[VERBOSE] ${message}`, ...args);
    }
  }
}

// シングルトンインスタンスをエクスポート
export const logger = Logger.getInstance();
