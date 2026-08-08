export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

export class Logger {
  private static instance: Logger;
  private level: LogLevel = LogLevel.INFO;
  private isTestEnv = false;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public setTestEnvironment(isTest: boolean): void {
    this.isTestEnv = isTest;
  }

  public error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  public info(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.INFO && !this.isTestEnv) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  public debug(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.DEBUG && !this.isTestEnv) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  public verbose(message: string, ...args: unknown[]): void {
    if (this.level >= LogLevel.VERBOSE && !this.isTestEnv) {
      console.log(`[VERBOSE] ${message}`, ...args);
    }
  }
}

export const logger = Logger.getInstance();
