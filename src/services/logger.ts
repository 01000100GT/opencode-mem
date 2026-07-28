import {
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

function getLogFilePath(): string {
  return process.env.OPENCODE_MEM_LOG_FILE || join(homedir(), ".opencode-mem", "opencode-mem.log");
}

function getLogDirPath(): string {
  const logFile = getLogFilePath();
  const lastSlash = Math.max(logFile.lastIndexOf("/"), logFile.lastIndexOf("\\"));
  return lastSlash === -1 ? "." : logFile.slice(0, lastSlash);
}

const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_LOG_DAYS = 30;

const GLOBAL_LOGGER_KEY = Symbol.for("opencode-mem.logger.initialized");
const LAST_ROTATE_DATE_KEY = Symbol.for("opencode-mem.logger.lastRotateDate");

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDateStamp(): string {
  return formatDate(new Date());
}

function rotateLog() {
  const logFile = getLogFilePath();
  try {
    if (!existsSync(logFile)) return;

    const stats = statSync(logFile);
    const dateStamp = getDateStamp();
    const logDir = getLogDirPath();

    const needRotate = (() => {
      if (stats.size >= MAX_LOG_SIZE) return true;
      const lastModified = formatDate(stats.mtime);
      return dateStamp !== lastModified;
    })();

    if (!needRotate) return;

    const archiveName = join(logDir, `opencode-mem-${getArchiveDate(stats)}.log`);
    if (!existsSync(archiveName)) {
      renameSync(logFile, archiveName);
    } else {
      const oldLog = logFile + ".old";
      if (existsSync(oldLog)) unlinkSync(oldLog);
      renameSync(logFile, oldLog);
    }

    cleanupOldLogs();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[opencode-mem] rotateLog failed: ${msg}\n`);
  }
}

function getArchiveDate(stats: { mtime: Date }): string {
  return formatDate(stats.mtime);
}

function cleanupOldLogs() {
  const logDir = getLogDirPath();
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  try {
    if (!existsSync(logDir)) return;
    const files = readdirSync(logDir);
    for (const file of files) {
      const match = file.match(/^opencode-mem-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      const dateStr = match[1]!;
      const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
      const fileDate = new Date(y, m - 1, d);
      if (fileDate.getTime() < cutoff) {
        unlinkSync(join(logDir, file));
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[opencode-mem] cleanupOldLogs failed: ${msg}\n`);
  }
}

function ensureLoggerInitialized() {
  if ((globalThis as any)[GLOBAL_LOGGER_KEY]) return;
  const logDir = getLogDirPath();
  const logFile = getLogFilePath();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  rotateLog();
  writeFileSync(logFile, `\n--- Session started: ${formatTimestamp(new Date())} ---\n`, {
    flag: "a",
  });
  (globalThis as any)[GLOBAL_LOGGER_KEY] = true;
}

export function log(message: string, data?: unknown) {
  ensureLoggerInitialized();

  const today = formatDate(new Date());
  if ((globalThis as any)[LAST_ROTATE_DATE_KEY] !== today) {
    (globalThis as any)[LAST_ROTATE_DATE_KEY] = today;
    rotateLog();
  }

  const logFile = getLogFilePath();
  const timestamp = formatTimestamp(new Date());
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(logFile, line);
}

// 全局唯一的Symbol键，用于在globalThis上存储已记录的诊断日志路径集合，避免重复日志
const DIAG_LOGGED_PATHS_KEY = Symbol.for("opencode-mem.diag.loggedPaths");

// 运行时从配置文件注入的 diag 开关；null 表示尚未注入
let configDiag: boolean | null = null;

// 由 config.ts 在 initConfig 时调用，把 opencode-mem.jsonc 的 diag 字段注入到此
// 这样可以避免 logger <-> config 之间的循环依赖
export function setDiagFromConfig(value: boolean): void {
  configDiag = value;
}

// 检查诊断日志功能是否启用：配置文件 diag 或环境变量 OPENCODE_MEM_DIAG=1，任一为 true 即启用
export function isDiagEnabled(): boolean {
  if (configDiag === true) return true;
  return process.env.OPENCODE_MEM_DIAG === "1";
}

export function truncateValue(value: string): string {
  if (value.length <= 8) return value;
  return value.slice(0, 8) + "...";
}

export function diagLog(location: string, message: string, data?: unknown) {
  if (!isDiagEnabled()) return;

  const loggedPaths: Set<string> = (globalThis as any)[DIAG_LOGGED_PATHS_KEY] || new Set();
  (globalThis as any)[DIAG_LOGGED_PATHS_KEY] = loggedPaths;

  const key = `${location}:${message}`;
  if (loggedPaths.has(key)) return;
  loggedPaths.add(key);

  log(`[DIAG] ${location} ${message}`, data);
}

export function diagLogOnce(location: string, message: string, data?: unknown) {
  diagLog(location, message, data);
}

export function diagWarn(location: string, message: string, data?: unknown) {
  if (!isDiagEnabled()) return;
  log(`[DIAG:WARN] ${location} ${message}`, data);
}

export function diagAlert(location: string, message: string, data?: unknown) {
  if (!isDiagEnabled()) return;
  log(`[DIAG:ALERT] ${location} ${message}`, data);
}
