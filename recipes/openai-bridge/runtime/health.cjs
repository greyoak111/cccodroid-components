#!/usr/bin/env node
// 仅探测安装时选定的回环端口，完全不连接用户的远端 API。
const http = require("node:http");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const BODY_LIMIT = 16 * 1024;
const LOG_LIMIT = 64 * 1024; // current + 一份 .1，各不超过 64 KiB；.lock 为零字节。
const REQUEST_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EACCES", "EPERM", "EPIPE", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
]);
const LOG_CODES = new Set([
  "LOG_UNSUPPORTED", "LOG_UNSAFE_PATH", "LOG_UNSAFE_FILE", "LOG_TOO_LARGE",
  "LOG_LOCK_BUSY", "LOG_LOCK_FAILED", "LOG_IO_ERROR",
]);

function diagnostic(code) {
  // code 只能来自本文件的固定分支/白名单，绝不拼接 error.message、URL、正文或路径。
  return `[${new Date().toISOString()}] health ${code}\n`;
}
function stderr(line) {
  try { fs.writeSync(2, line); } catch { /* 关闭的 stderr 不应触发含堆栈的异常输出。 */ }
}

class LogFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function refuse(code) { throw new LogFailure(code); }

// 调用方必须先验证 STATE，再显式传入绝对路径；不从 HOME/远端响应推导日志路径。
// Node 没有 openat/flock API。Linux/Android 的 /proc/self/fd/<dirfd>/<单个段>
// 将每次 open 锚定到已打开目录；O_NOFOLLOW 拒绝所有用户路径中的符号链接。
// 最后一级目录必须为本 uid 的 0700，不修复/接管已有的不安全目录或文件。
function appendLog(logPath, line) {
  let directory, lock, current;
  const c = fs.constants;
  const close = (fd) => { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } };
  try {
    if (!process.getuid || !["linux", "android"].includes(process.platform) ||
        !c.O_NOFOLLOW || !c.O_DIRECTORY) refuse("LOG_UNSUPPORTED");
    if (typeof logPath !== "string" || !logPath.startsWith("/") ||
        Buffer.byteLength(logPath) > 4096 || logPath.includes("\0")) refuse("LOG_UNSAFE_PATH");
    const parts = logPath.slice(1).split("/");
    if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) {
      refuse("LOG_UNSAFE_PATH");
    }
    const name = parts.pop();
    if (name.length > 80 || !/^[A-Za-z0-9]/.test(name) || /[^A-Za-z0-9._-]/.test(name)) {
      refuse("LOG_UNSAFE_PATH");
    }
    const uid = process.getuid();
    // Android 对 / 等祖先可能只允许搜索不允许读取；Linux O_PATH 只取路径句柄。
    // Node 未导出该常量时使用 Linux/Android 固定值，平台已在上方 fail-closed。
    const directoryFlags = (c.O_PATH || 0x200000) | c.O_DIRECTORY | c.O_NOFOLLOW;
    try {
      directory = fs.openSync("/", directoryFlags);
      for (const part of parts) {
        const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, directoryFlags);
        close(directory);
        directory = next;
      }
      const stat = fs.fstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
        refuse("LOG_UNSAFE_PATH");
      }
    } catch { refuse("LOG_UNSAFE_PATH"); }
    const entry = (base) => `/proc/self/fd/${directory}/${base}`;
    const check = (stat, isLock = false) => {
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 ||
          (stat.mode & 0o7777) !== 0o600) refuse("LOG_UNSAFE_FILE");
      if (stat.size > (isLock ? 0 : LOG_LIMIT)) refuse("LOG_TOO_LARGE");
    };
    const inspect = (base, isLock = false) => {
      let stat;
      try { stat = fs.lstatSync(entry(base)); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      check(stat, isLock);
      return stat;
    };
    const verify = (fd, base, isLock = false) => {
      const stat = fs.fstatSync(fd);
      check(stat, isLock);
      const named = inspect(base, isLock);
      if (!named || named.dev !== stat.dev || named.ino !== stat.ino) refuse("LOG_UNSAFE_FILE");
      return stat;
    };
    const open = (base, isLock = false) => {
      inspect(base, isLock); // FIFO/设备/链接在打开前即拒绝，O_NONBLOCK 也避免竞态挂住。
      const flags = c.O_RDWR | c.O_NOFOLLOW | c.O_NONBLOCK | (isLock ? 0 : c.O_APPEND);
      let fd, created = false;
      try {
        try {
          fd = fs.openSync(entry(base), flags | c.O_CREAT | c.O_EXCL, 0o600);
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          fd = fs.openSync(entry(base), flags);
        }
        if (created) fs.fchmodSync(fd, 0o600);
        verify(fd, base, isLock);
        return fd;
      } catch (error) { close(fd); throw error; }
    };

    inspect(name);
    inspect(`${name}.1`);
    lock = open(`${name}.lock`, true);
    // flock 子进程只给同一个 open-file-description 加锁；父进程持有 fd 到写完。
    // 进程崩溃自动解锁，无陈旧 PID/锁目录；等待和子进程执行均有上限。
    const result = spawnSync("flock", ["-w", "1", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock], timeout: 1200,
    });
    if (result.error || result.signal || result.status !== 0) {
      refuse(result.status === 1 ? "LOG_LOCK_BUSY" : "LOG_LOCK_FAILED");
    }
    verify(lock, `${name}.lock`, true);
    inspect(`${name}.1`);
    current = open(name);
    const stat = verify(current, name);
    if (stat.size + Buffer.byteLength(line) > LOG_LIMIT) {
      // 锁内 rename 原子替换 backup；不复制无界内容、不创建无界临时文件。
      fs.renameSync(entry(name), entry(`${name}.1`));
      verify(current, `${name}.1`);
      close(current);
      current = undefined;
      current = open(name);
    }
    verify(current, name);
    fs.writeFileSync(current, line);
    fs.fsyncSync(current);
  } catch (error) {
    return error instanceof LogFailure && LOG_CODES.has(error.code) ? error.code : "LOG_IO_ERROR";
  } finally {
    close(current);
    close(lock); // 同时释放 flock。
    close(directory);
  }
}

function requestCode(error) {
  if (REQUEST_CODES.has(error?.code)) return error.code;
  if (error?.code === "HPE_HEADER_OVERFLOW") return "RESPONSE_TOO_LARGE";
  return "REQUEST_ERROR";
}

// 只有已监听的独立回环对照也失败，才能把服务故障归为探测环境不可用。
// 不读系统策略、不连远端、不把 PID 存活当健康；端口随机且只接受随机短令牌。
function loopbackAvailable() {
  return new Promise((resolve) => {
    const token = randomBytes(16);
    const sockets = new Set();
    let client, timer, done = false, listening = false;
    const server = net.createServer((socket) => {
      if (done || sockets.size >= 4) { socket.destroy(); return; }
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      let bytes = Buffer.alloc(0);
      socket.on("data", (part) => {
        if (bytes.length + part.length > token.length) { socket.destroy(); return; }
        bytes = Buffer.concat([bytes, part]);
        if (bytes.length === token.length) {
          if (bytes.equals(token)) socket.end(token);
          else socket.destroy();
        }
      });
    });
    const complete = (available) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client?.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
      resolve(available);
    };
    // null=无法构造有效对照，不能据此延期服务故障（如资源耗尽或 bind 失败）。
    server.on("error", () => complete(null));
    timer = setTimeout(() => complete(listening ? false : null), 2000);
    try {
      server.listen(0, "127.0.0.1", () => {
        if (done) { server.close(); return; }
        listening = true;
        client = net.connect({ host: "127.0.0.1", port: server.address().port });
        client.on("connect", () => client.write(token));
        let bytes = Buffer.alloc(0);
        client.on("data", (part) => {
          if (bytes.length + part.length > token.length) { complete(null); return; }
          bytes = Buffer.concat([bytes, part]);
          if (bytes.length === token.length) complete(bytes.equals(token) ? true : null);
        });
        client.on("error", (error) => complete(
          ["EACCES", "EPERM", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code) ? false : null));
        client.on("end", () => complete(null));
      });
    } catch { complete(null); }
  });
}

const args = process.argv.slice(2);
const diagnose = args.at(-1) === "--diagnose";
if (diagnose) args.pop();
const validShape = args.length === 1 || (args.length === 3 && args[1] === "--log");
const validArgs = validShape && typeof args[0] === "string" &&
  args[0].length >= 4 && args[0].length <= 5 && args[0][0] !== "0" &&
  !/[^0-9]/.test(args[0]) && Number(args[0]) >= 1024 && Number(args[0]) <= 65535;
const logPath = validShape && args.length === 3 ? args[2] : undefined;
let finished = false, request, response, deadline;
async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  response?.destroy();
  request?.destroy();
  let exitCode = code ? 1 : 0;
  if (diagnose && (code === "DEADLINE_2000MS" || REQUEST_CODES.has(code))) {
    try {
      if (await loopbackAvailable() === false) {
        code = "LOOPBACK_UNAVAILABLE";
        exitCode = 2;
      }
    } catch { /* 无法完成对照时按原服务故障处理，不能无证据延期。 */ }
  }
  process.exitCode = exitCode;
  if (code) {
    const line = diagnostic(code);
    if (logPath === undefined) stderr(line);
    else {
      const logCode = appendLog(logPath, line);
      // 已安全写入时不重复污染 bridge.out；日志本身失效时不能再静默吞掉诊断。
      if (logCode) { stderr(line); stderr(diagnostic(logCode)); }
    }
  }
}

if (!validArgs) {
  finish("INVALID_ARGUMENTS");
} else {
  // 单一绝对 deadline，覆盖连接、响应头、整个正文，不随 data/header 重置。
  const expires = performance.now() + 2000;
  const expired = () => {
    if (performance.now() < expires) return false;
    finish("DEADLINE_2000MS");
    return true;
  };
  deadline = setTimeout(() => finish("DEADLINE_2000MS"), 2000);
  try {
    request = http.get({ hostname: "127.0.0.1", port: Number(args[0]), path: "/health",
      agent: false, maxHeaderSize: BODY_LIMIT }, (incoming) => {
      response = incoming;
      response.on("error", () => { if (!expired()) finish("RESPONSE_ABORTED"); });
      response.on("aborted", () => { if (!expired()) finish("RESPONSE_ABORTED"); });
      response.on("close", () => { if (!response.complete && !expired()) finish("RESPONSE_ABORTED"); });
      if (finished) { response.destroy(); return; }
      if (expired()) return;
      if (response.statusCode !== 200) { finish("HTTP_STATUS"); return; }
      const parts = [];
      let bytes = 0;
      response.on("data", (part) => {
        if (finished || expired()) return;
        bytes += part.length; // Buffer 的字节数，而非解码后的 UTF-16 字符数。
        if (bytes > BODY_LIMIT) { finish("RESPONSE_TOO_LARGE"); return; }
        parts.push(part);
      });
      response.on("end", () => {
        if (finished || expired()) return;
        let body;
        try { body = JSON.parse(Buffer.concat(parts, bytes).toString("utf8")); }
        catch { finish("BAD_JSON"); return; }
        if (!expired()) finish(body && body.status === "ok" ? undefined : "HEALTH_STATUS");
      });
    });
    request.on("error", (error) => { if (!expired()) finish(requestCode(error)); });
  } catch (error) { if (!expired()) finish(requestCode(error)); }
}
