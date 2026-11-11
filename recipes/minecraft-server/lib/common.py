"""Shared paths, config and small helpers for minecraft-server."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve()
COMPONENT_DIR = HERE.parent.parent
# .../<prefix>/share/cccodroid/components/minecraft-server/lib/common.py
PREFIX = Path(os.environ.get("PREFIX") or HERE.parents[5])

PAPER_VERSION = "1.21.11-132"
PAPER_SHA256 = "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
JAVA_MIN = 21
DEFAULT_PORT = 25565
DEFAULT_MEMORY = "2G"
MIN_MEMORY_MB = 512
MAX_MEMORY_MB = 8192

DATA = Path(os.environ.get("CCCODROID_MINECRAFT_DATA") or (Path.home() / ".cccodroid" / "minecraft-server")).expanduser()
PAPER_JAR = COMPONENT_DIR / "paper.jar"
SERVER_PROPS = DATA / "server.properties"
EULA_FILE = DATA / "eula.txt"
CONFIG_FILE = DATA / "config.json"
LOG_DIR = DATA / "logs"
SERVER_LOG = LOG_DIR / "server.log"
SUPERVISOR_LOG = LOG_DIR / "supervisor.log"
RUN_DIR = DATA / "run"
STATE_FILE = RUN_DIR / "state.json"
CONTROL_SOCK = RUN_DIR / "control.sock"
BACKUP_DIR = DATA / "backups"
HOME_DIR = DATA / "home"
TMP_DIR = DATA / "tmp"


def ensure_layout() -> None:
    for d in (DATA, LOG_DIR, RUN_DIR, BACKUP_DIR, HOME_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass


def atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        os.chmod(tmp, mode)
    except OSError:
        pass
    tmp.replace(path)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj, mode: int = 0o600) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n", mode)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def java_binary() -> str | None:
    return os.environ.get("JAVA") or shutil.which("java") or str(PREFIX / "bin" / "java")


def java_version() -> tuple[int | None, str]:
    java = java_binary()
    if not java or not Path(java).exists():
        return None, "java 不存在"
    try:
        p = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    text = (p.stderr or "") + (p.stdout or "")
    m = re.search(r'version "(\d+)(?:\.(\d+))?', text)
    if not m:
        return None, text.strip()[:200] or "读不出版本"
    major = int(m.group(1))
    if major == 1 and m.group(2):
        major = int(m.group(2))
    first = text.strip().splitlines()[0] if text.strip() else ""
    return major, first


def normalize_memory(value: str) -> str:
    m = re.fullmatch(r"\s*(\d+)\s*([MmGg])\s*", value or "")
    if not m:
        raise ValueError("内存要写成 2G / 1536M 这种形式")
    n = int(m.group(1))
    mb = n * 1024 if m.group(2).lower() == "g" else n
    if mb < MIN_MEMORY_MB or mb > MAX_MEMORY_MB:
        raise ValueError(f"内存在 {MIN_MEMORY_MB}M–{MAX_MEMORY_MB // 1024}G 之间")
    return f"{n}{m.group(2).upper()}"


def load_config() -> dict:
    cfg = read_json(CONFIG_FILE, {}) or {}
    try:
        cfg["memory"] = normalize_memory(str(cfg.get("memory", DEFAULT_MEMORY)))
    except ValueError:
        cfg["memory"] = DEFAULT_MEMORY
    return cfg


def save_config(cfg: dict) -> None:
    write_json(CONFIG_FILE, {"memory": normalize_memory(cfg.get("memory", DEFAULT_MEMORY))})


def parse_properties(path: Path = SERVER_PROPS) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def server_port() -> int:
    try:
        return int(parse_properties().get("server-port", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT


def server_ip_raw() -> str:
    """Raw server-ip from server.properties; empty string means all interfaces."""
    return parse_properties().get("server-ip", "").strip()


def server_bind() -> str:
    """Return the address clients should use on this device: 127.0.0.1 unless bound elsewhere."""
    ip = server_ip_raw()
    if not ip or ip in ("0.0.0.0", "::"):
        return "127.0.0.1"
    return ip


def port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def process_alive(pid) -> bool:
    try:
        pid = int(pid)
        os.kill(pid, 0)
        return True
    except (TypeError, ValueError, OSError):
        return False


def read_state() -> dict | None:
    s = read_json(STATE_FILE, None)
    return s if isinstance(s, dict) else None


def write_state(state: dict) -> None:
    write_json(STATE_FILE, state)


def clear_state() -> None:
    try:
        STATE_FILE.unlink()
    except OSError:
        pass


def control_send(req: dict, timeout: float = 8.0) -> dict:
    if not CONTROL_SOCK.exists():
        raise RuntimeError("控制套接字不存在（服务没在运行）")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(str(CONTROL_SOCK))
        s.sendall((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        data = b""
        while b"\n" not in data:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        if not data:
            raise RuntimeError("控制套接字没有返回")
        return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))
    finally:
        try:
            s.close()
        except OSError:
            pass


def tail(path: Path, lines: int = 80) -> str:
    try:
        data = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(data[-lines:])


def human_uptime(seconds: float) -> str:
    seconds = int(max(0, seconds))
    d, r = divmod(seconds, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    if d:
        return f"{d}天{h}小时"
    if h:
        return f"{h}小时{m}分"
    if m:
        return f"{m}分{s}秒"
    return f"{s}秒"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
