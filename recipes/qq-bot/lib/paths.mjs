import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// $PREFIX/share/cccodroid/components/qq-bot/lib -> $PREFIX
export const PREFIX =
  process.env.PREFIX ||
  path.resolve(HERE, "..", "..", "..", "..", "..");

export const HOME = process.env.HOME || os.homedir();
export const ROOT =
  process.env.CCCODROID_QQ_BOT_DATA || path.join(HOME, ".cccodroid", "qq-bot");

export const DATA = path.join(ROOT, "data");
export const DEBROOT = path.join(DATA, "debroot");
export const QQ_DIR = path.join(DEBROOT, "opt", "QQ");
export const QQ_BIN = path.join(QQ_DIR, "qq");
export const APP_DIR = path.join(QQ_DIR, "resources", "app");
export const NAPCAT_DIR = path.join(APP_DIR, "app_launcher", "napcat");
export const QR_FILE = path.join(NAPCAT_DIR, "cache", "qrcode.png");
export const NAPCAT_CONFIG = path.join(NAPCAT_DIR, "config");
export const ONE_BOT_CONFIG = path.join(NAPCAT_CONFIG, "onebot11.json");

export const CONFIG_FILE = path.join(ROOT, "config.json");
export const API_KEY_FILE = path.join(ROOT, "model-key.txt");
export const STATE_FILE = path.join(ROOT, "state.json");
export const SETUP_FILE = path.join(DATA, "setup.json");
export const LOG_DIR = path.join(ROOT, "logs");
export const HOME_DIR = path.join(DATA, "home");
export const TMP_DIR = path.join(DATA, "tmp");
export const RUN_DIR = path.join(DATA, "run");
export const CACHE_DIR = path.join(DATA, "cache");
export const LIB_DIR = path.join(DATA, "libpath.txt");

export const LIB_INSTALLER = path.join(
  PREFIX,
  "share",
  "cccodroid",
  "components",
  "qq-bot",
  "lib",
  "install.py",
);
export const LIB_SELFTEST = path.join(HERE, "selftest.mjs");
export const LIB_SUPERVISOR = path.join(HERE, "supervisor.mjs");

export function ensureLayout() {
  for (const d of [ROOT, DATA, LOG_DIR, HOME_DIR, TMP_DIR, RUN_DIR, CACHE_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(RUN_DIR, 0o700);
  } catch {}
}

export function nodeBin() {
  return process.execPath;
}

export function pythonBin() {
  return process.env.PYTHON || "python3";
}
