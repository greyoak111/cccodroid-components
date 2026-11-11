#!/usr/bin/env python3
"""Detached Minecraft server supervisor: Java process + Unix control socket."""

from __future__ import annotations

import json
import os
import signal
import socketserver
import subprocess
import tarfile
import threading
import time

from common import (
    BACKUP_DIR, CONTROL_SOCK, DATA, EULA_FILE, HOME_DIR, JAVA_MIN, PAPER_JAR, PAPER_SHA256, PAPER_VERSION, PREFIX, SERVER_LOG,
    TMP_DIR, clear_state, ensure_layout, java_binary, java_version,
    load_config, now_iso, parse_properties, process_alive, read_state,
    server_port, sha256_file, write_state,
)

stop_requested = threading.Event()
stdin_lock = threading.Lock()
proc: subprocess.Popen | None = None
state: dict = {}
server: socketserver.UnixStreamServer | None = None


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def eula_accepted() -> bool:
    import re
    try:
        text = EULA_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(re.search(r"^\s*eula\s*=\s*true\s*$", text, re.I | re.M))


def rotate_log() -> None:
    try:
        if SERVER_LOG.exists() and SERVER_LOG.stat().st_size > 20 * 1024 * 1024:
            old = SERVER_LOG.with_suffix(".log.1")
            if old.exists():
                old.unlink()
            SERVER_LOG.rename(old)
    except OSError:
        pass


def send_console(line: str) -> None:
    global proc
    if not proc or proc.poll() is not None:
        raise RuntimeError("Java 进程不在运行")
    with stdin_lock:
        if not proc or proc.poll() is not None:
            raise RuntimeError("Java 进程不在运行")
        assert proc.stdin is not None
        proc.stdin.write((line + "\n").encode("utf-8"))
        proc.stdin.flush()


def do_backup() -> str:
    if not proc or proc.poll() is not None:
        raise RuntimeError("服务器没在运行")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = BACKUP_DIR / ("world-" + time.strftime("%Y%m%d-%H%M%S") + ".tar.gz")
    names = ["world", "world_nether", "world_the_end", "server.properties", "ops.json",
             "whitelist.json", "banned-players.json", "banned-ips.json"]
    if not (DATA / "world").exists():
        raise RuntimeError("world 目录还不存在（服务器还没生成世界）")
    send_console("save-off")
    send_console("save-all flush")
    time.sleep(3)
    try:
        with tarfile.open(target, "w:gz") as tar:
            for name in names:
                p = DATA / name
                if p.exists():
                    tar.add(p, arcname=name)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
        return str(target)
    finally:
        try:
            send_console("save-on")
        except RuntimeError:
            pass


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        try:
            raw = self.rfile.readline(65536)
            if not raw:
                return
            req = json.loads(raw.decode("utf-8"))
            resp = self.dispatch(req if isinstance(req, dict) else {})
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        try:
            self.wfile.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        except OSError:
            pass

    def dispatch(self, req: dict) -> dict:
        cmd = req.get("cmd")
        if cmd == "ping":
            return {"ok": True, "pid": os.getpid()}
        if cmd == "status":
            return {
                "ok": True,
                "pid": os.getpid(),
                "javaPid": proc.pid if proc else None,
                "javaAlive": bool(proc and proc.poll() is None),
                "startedAt": state.get("startedAt"),
                "port": state.get("port"),
                "bind": state.get("bind"),
                "memory": state.get("memory"),
                "paper": PAPER_VERSION,
            }
        if cmd == "console":
            line = str(req.get("line") or "").strip()
            if not line or "\n" in line or "\r" in line:
                raise RuntimeError("命令为空或含换行")
            send_console(line)
            return {"ok": True}
        if cmd == "backup":
            return {"ok": True, "path": do_backup()}
        if cmd == "stop":
            stop_requested.set()
            return {"ok": True, "stopping": True}
        raise RuntimeError("不认识的命令：" + str(cmd))


def start_control() -> None:
    global server
    try:
        CONTROL_SOCK.unlink()
    except OSError:
        pass
    server = socketserver.ThreadingUnixStreamServer(str(CONTROL_SOCK), ControlHandler)
    server.daemon_threads = True
    try:
        os.chmod(CONTROL_SOCK, 0o600)
    except OSError:
        pass
    t = threading.Thread(target=server.serve_forever, name="control", daemon=True)
    t.start()
    log(f"控制套接字：{CONTROL_SOCK}")


def start_java() -> None:
    global proc
    major, text = java_version()
    if major is None or major < JAVA_MIN:
        raise RuntimeError(f"Java 版本不够：{text}（需要 {JAVA_MIN}+）")
    if not PAPER_JAR.exists():
        raise RuntimeError(f"Paper jar 不存在：{PAPER_JAR}")
    if sha256_file(PAPER_JAR) != PAPER_SHA256:
        raise RuntimeError("Paper jar 的 sha256 不对，组件安装不完整")
    if not (DATA / "server.properties").exists():
        raise RuntimeError("server.properties 不存在，先 setup")
    if not eula_accepted():
        raise RuntimeError("Minecraft EULA 未接受，先 setup --accept-eula")

    memory = load_config()["memory"]
    rotate_log()
    env = os.environ.copy()
    env["PREFIX"] = str(PREFIX)
    env["HOME"] = str(HOME_DIR)
    env["TMPDIR"] = str(TMP_DIR)
    env["CCCODROID_MINECRAFT_DATA"] = str(DATA)
    logf = open(SERVER_LOG, "ab", buffering=0)
    args = [
        java_binary(), "-Xms512M", f"-Xmx{memory}", "-XX:+UseG1GC",
        f"-Djava.io.tmpdir={TMP_DIR}", "-Dfile.encoding=UTF-8",
        "-jar", str(PAPER_JAR), "nogui",
    ]
    log("启动 Java：" + " ".join(args))
    try:
        proc = subprocess.Popen(
            args, cwd=str(DATA), stdin=subprocess.PIPE, stdout=logf,
            stderr=subprocess.STDOUT, env=env, close_fds=True,
        )
    finally:
        logf.close()
    state.update({
        "pid": os.getpid(),
        "javaPid": proc.pid,
        "startedAt": now_iso(),
        "port": server_port(),
        "bind": "lan" if not parse_properties().get("server-ip", "").strip() else "loopback",
        "memory": memory,
        "paper": PAPER_VERSION,
    })
    write_state(state)
    log(f"Java 已启动 pid={proc.pid}，内存 {memory}")


def request_stop(reason: str) -> None:
    if stop_requested.is_set():
        return
    log(f"收到停止请求（{reason}）")
    stop_requested.set()


def cleanup() -> None:
    global server
    if server:
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass
        server = None
    try:
        CONTROL_SOCK.unlink()
    except OSError:
        pass
    cur = read_state()
    if not cur or cur.get("pid") == os.getpid():
        clear_state()
    log("supervisor 退出")


def main() -> None:
    ensure_layout()
    signal.signal(signal.SIGTERM, lambda *_: request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: request_stop("SIGINT"))

    existing = read_state()
    if existing and existing.get("pid") != os.getpid() and process_alive(existing.get("pid")):
        log(f"已有实例 pid={existing.get('pid')}，退出")
        return

    state.clear()
    start_java()
    start_control()
    graceful_deadline: float | None = None
    try:
        while proc is not None and proc.poll() is None:
            if stop_requested.is_set() and graceful_deadline is None:
                try:
                    send_console("stop")
                    log("已向服务器发送 stop，等待存档退出…")
                except RuntimeError as e:
                    log(f"发送 stop 失败：{e}")
                graceful_deadline = time.time() + 90
            if graceful_deadline is not None and time.time() > graceful_deadline:
                log("90 秒内没退出，终止 Java")
                proc.terminate()
                graceful_deadline = float("inf")
                time.sleep(1)
                if proc.poll() is None:
                    proc.kill()
                break
            time.sleep(0.25)
        code = proc.wait() if proc else None
        log(f"Java 退出 code={code}")
    finally:
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass
        cleanup()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"启动失败：{e}")
        try:
            if proc and proc.poll() is None:
                proc.kill()
        except OSError:
            pass
        cleanup()
        raise SystemExit(1)
