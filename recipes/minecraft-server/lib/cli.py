#!/usr/bin/env python3
"""minecraft-server: Paper Minecraft Java server on cccodroid."""

from __future__ import annotations

import calendar
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

from common import (
    BACKUP_DIR, COMPONENT_DIR, CONFIG_FILE, CONTROL_SOCK, DATA, DEFAULT_MEMORY,
    DEFAULT_PORT, EULA_FILE, HOME_DIR, JAVA_MIN, PAPER_JAR, PAPER_SHA256,
    PAPER_VERSION, PREFIX, SERVER_LOG, SERVER_PROPS, SUPERVISOR_LOG, TMP_DIR, atomic_write, clear_state, control_send,
    ensure_layout, human_uptime, java_version, load_config,
    normalize_memory, parse_properties, port_open, process_alive,
    read_state, save_config, server_port, sha256_file,
    tail,
)

HELP = f"""minecraft-server —— 手机上原生跑 Minecraft Java 服务端（Paper）

安装（Paper 已随组件装好，52 MB）：
  minecraft-server setup --check
      只报告路径、Java、EULA 状态，不写文件
  minecraft-server setup --accept-eula
      用户读完并接受 Minecraft EULA 后执行；会创建数据目录和 server.properties
      可选：--lan（监听局域网，默认只监听 127.0.0.1）
            --port 25565  --whitelist  --memory 2G

运行：
  minecraft-server start [--wait 秒]  后台启动；默认等 60 秒，首次打补丁可能要 5–15 分钟
  minecraft-server stop       优雅停止（先发 stop，再等存档）
  minecraft-server restart
  minecraft-server status     进程、地址、运行时间、最后一行日志
  minecraft-server console <命令...>   向服务器控制台发命令，如 list / say / op
  minecraft-server whitelist on|off|list|add <名字>|remove <名字>
  minecraft-server backup     服务器运行时先 save-off/save-all，再打包世界
  minecraft-server logs [行数]  看日志（可能含玩家聊天；先问用户）

配置：
  minecraft-server config                 打印路径和 server.properties 关键项
  minecraft-server config set memory 2G   下次 start 生效
  minecraft-server config set port 25566  需先 stop
  minecraft-server config set bind loopback|lan|<IP>  需先 stop
  minecraft-server config set whitelist on|off        需先 stop

排查：
  minecraft-server selftest   不联网、不启动世界，检查 Java、Paper jar、配置
  minecraft-server version

数据目录：{DATA}
Paper：{PAPER_VERSION}（GPL-3.0）
Minecraft 服务端 jar 不在组件里；首次 start 由 Paper 从 Mojang 官方下载。
"""


def out(s: str = "") -> None:
    print(s)


def err(s: str) -> None:
    print(s, file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    err("minecraft-server: " + msg)
    raise SystemExit(code)


def eula_accepted() -> bool:
    try:
        text = EULA_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(re.search(r"^\s*eula\s*=\s*true\s*$", text, re.I | re.M))


def check_paper() -> str | None:
    if not PAPER_JAR.exists():
        return f"Paper jar 不存在：{PAPER_JAR}（组件安装不完整，重装组件）"
    try:
        digest = sha256_file(PAPER_JAR)
    except OSError as e:
        return f"读不了 Paper jar：{e}"
    if digest != PAPER_SHA256:
        return f"Paper jar 的 sha256 不对（得到 {digest}），组件安装不完整，重装组件"
    return None


def check_java() -> str | None:
    major, text = java_version()
    if major is None:
        return f"找不到可用的 Java：{text}"
    if major < JAVA_MIN:
        return f"Java {major} 太旧，Paper {PAPER_VERSION} 需要 Java {JAVA_MIN}+（当前：{text}）"
    return None


def check_ready() -> None:
    for msg in (check_java(), check_paper()):
        if msg:
            die(msg)
    if not SERVER_PROPS.exists():
        die("还没初始化。先跑 minecraft-server setup --check，征得用户同意后用 --accept-eula")
    if not eula_accepted():
        die("还没接受 Minecraft EULA。让用户读 https://aka.ms/MinecraftEULA，同意后再跑 setup --accept-eula")


def raw_server_ip() -> str:
    return parse_properties().get("server-ip", "").strip()


def connect_host() -> str:
    ip = raw_server_ip()
    if not ip or ip in ("0.0.0.0", "::"):
        return "127.0.0.1"
    return ip


def address_display() -> str:
    port = server_port()
    ip = raw_server_ip()
    if not ip:
        return f"0.0.0.0:{port}（局域网可连）"
    if ip in ("127.0.0.1", "::1"):
        return f"127.0.0.1:{port}（仅本机）"
    return f"{ip}:{port}"


def whitelist_display() -> str:
    v = parse_properties().get("white-list", "false").strip().lower()
    return "on" if v in ("true", "on") else "off"


def server_running() -> tuple[dict | None, bool]:
    st = read_state()
    if st and process_alive(st.get("pid")):
        return st, True
    return st, False


ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def last_log_line() -> str:
    for line in reversed(tail(SERVER_LOG, 40).splitlines()):
        line = ANSI_RE.sub("", line).replace("\r", " ").strip()
        line = re.sub(r"^(?:>\s*)+", "", line).strip()
        if not line or set(line) <= {"*", "-", "="}:
            continue
        return line
    return ""


def pid_cmdline(pid) -> str:
    try:
        return Path(f"/proc/{int(pid)}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except (OSError, TypeError, ValueError):
        return ""


def find_java_pids() -> list[int]:
    found = []
    try:
        for ent in Path("/proc").iterdir():
            if not ent.name.isdigit():
                continue
            if str(PAPER_JAR) in pid_cmdline(ent.name):
                found.append(int(ent.name))
    except OSError:
        pass
    return found


def kill_pid(pid, sig) -> bool:
    try:
        os.kill(int(pid), sig)
        return True
    except (OSError, TypeError, ValueError):
        return False


def server_properties_template(port: int, lan: bool, whitelist: bool) -> str:
    return f"""# Generated by cccodroid minecraft-server. Stop the server before editing.
server-ip={'127.0.0.1' if not lan else ''}
server-port={port}
online-mode=true
white-list={'true' if whitelist else 'false'}
max-players=5
view-distance=6
simulation-distance=4
level-name=world
gamemode=survival
difficulty=easy
motd=cccodroid Minecraft
enable-status=true
enable-query=false
enable-rcon=false
enable-command-block=false
spawn-protection=0
allow-flight=false
allow-nether=true
allow-end=true
pvp=true
hardcore=false
force-gamemode=false
require-resource-pack=false
enforce-secure-profile=true
network-compression-threshold=256
use-native-transport=false
sync-chunk-writes=false
pause-when-empty-seconds=60
"""


def set_property(key: str, value: str) -> None:
    lines = SERVER_PROPS.read_text(encoding="utf-8", errors="replace").splitlines()
    found = False
    for i, line in enumerate(lines):
        if line.strip().startswith("#"):
            continue
        if line.split("=", 1)[0].strip() == key:
            lines[i] = f"{key}={value}"
            found = True
    if not found:
        lines.append(f"{key}={value}")
    atomic_write(SERVER_PROPS, "\n".join(lines) + "\n", 0o600)


def print_check() -> None:
    out(f"数据目录：{DATA}")
    out(f"Paper jar：{PAPER_JAR}（{PAPER_VERSION}，GPL-3.0）")
    if PAPER_JAR.exists():
        out(f"           {PAPER_JAR.stat().st_size / 1048576:.1f} MB")
    else:
        out("           （缺失，组件安装不完整）")
    major, text = java_version()
    out(f"Java：{text or '未找到'}" + (f"（{major}）" if major else ""))
    out(f"EULA：{'已接受' if eula_accepted() else '未接受'}")
    out(f"server.properties：{'存在' if SERVER_PROPS.exists() else '不存在'}")
    if SERVER_PROPS.exists():
        out(f"监听：{address_display()}")
        out(f"白名单：{whitelist_display()}")
    out("首次 start：Paper 会从 Mojang 官方下载 Minecraft 1.21.11 服务端（约 54 MB）并打补丁，需要联网。")


def cmd_setup(args: list[str]) -> None:
    accept = "--accept-eula" in args
    lan = "--lan" in args
    whitelist = "--whitelist" in args
    port = DEFAULT_PORT
    memory = None
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            try:
                port = int(args[i + 1])
            except ValueError:
                die("--port 需要数字")
        if a == "--memory" and i + 1 < len(args):
            memory = args[i + 1]
    if "--check" in args:
        print_check()
        return
    if port < 1024 or port > 65535:
        die("端口要在 1024–65535 之间（1024 以下 Android 普通应用绑不了）")
    memory_norm = None
    if memory:
        try:
            memory_norm = normalize_memory(memory)
        except ValueError as e:
            die(str(e))

    for msg in (check_java(), check_paper()):
        if msg:
            die(msg)
    if not accept and not eula_accepted():
        die("Minecraft EULA 还没接受。让用户读 https://aka.ms/MinecraftEULA 并明确同意后，再加 --accept-eula 重跑", 2)

    ensure_layout()
    if not eula_accepted():
        atomic_write(EULA_FILE, "# Generated by cccodroid minecraft-server after the user accepted the Minecraft EULA.\neula=true\n", 0o600)
        out("EULA：已按用户确认写入 eula=true")

    if SERVER_PROPS.exists():
        out("server.properties：已存在，保留原设置（--lan/--port/--whitelist 这次不覆盖）")
    else:
        atomic_write(SERVER_PROPS, server_properties_template(port, lan, whitelist), 0o600)
        out(f"server.properties：已创建，监听 {address_display()}，白名单 {'on' if whitelist else 'off'}")

    cfg = load_config()
    if memory_norm:
        cfg["memory"] = memory_norm
        save_config(cfg)
    elif not CONFIG_FILE.exists():
        save_config({"memory": DEFAULT_MEMORY})

    out(f"数据目录：{DATA}")
    out(f"Paper：{PAPER_VERSION}（{PAPER_JAR.stat().st_size / 1048576:.1f} MB，已随组件安装）")
    out("首次 start：Paper 会从 Mojang 官方下载 Minecraft 1.21.11 服务端（约 54 MB）并打补丁，需要联网。")
    out("下一步：minecraft-server start")


def cmd_start(args: list[str]) -> None:
    wait_seconds = 60
    for i, a in enumerate(args):
        if a == "--wait" and i + 1 < len(args):
            try:
                wait_seconds = max(0, min(900, int(args[i + 1])))
            except ValueError:
                die("--wait 需要秒数")
    check_ready()
    st, running = server_running()
    if running:
        out(f"已经在运行（supervisor pid {st.get('pid')}，Java pid {st.get('javaPid')}）")
        out(f"地址：{address_display()}")
        return

    orphans = find_java_pids()
    if orphans:
        die(f"发现没有 supervisor 的 Java 进程 {orphans}；先 minecraft-server stop 清理")

    ensure_layout()
    # 清掉上次被 SIGKILL 留下的旧状态/套接字；先确认没有活着的 Java
    if st and st.get("javaPid") and process_alive(st.get("javaPid")) and "paper.jar" in pid_cmdline(st.get("javaPid")):
        die(f"状态文件里还有活着的 Java 进程 {st.get('javaPid')}；先 minecraft-server stop")
    clear_state()
    try:
        CONTROL_SOCK.unlink()
    except OSError:
        pass

    env = os.environ.copy()
    # 服务器要常驻，不算 Claude 的这一轮：去掉 cccodroid 的运行标记，否则停止这一轮或网关重启时
    # 会被当成那一轮留下的进程清掉（同 openai-bridge 的 start-bridge.sh）
    for k in ("CCAPP_RUN", "CCAPP_RUN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"):
        env.pop(k, None)
    env["PREFIX"] = str(PREFIX)
    env["CCCODROID_MINECRAFT_DATA"] = str(DATA)
    env["TMPDIR"] = str(TMP_DIR)
    env["HOME"] = os.environ.get("HOME", str(HOME_DIR))
    sup = Path(__file__).with_name("supervisor.py")
    log = open(SUPERVISOR_LOG, "ab", buffering=0)
    try:
        subprocess.Popen(
            [sys.executable, str(sup)],
            cwd=str(DATA),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=env,
        )
    except OSError as e:
        die(f"启动 supervisor 失败：{e}")
    finally:
        log.close()

    st = read_state()
    deadline = time.time() + 15
    while time.time() < deadline:
        st = read_state()
        if st and process_alive(st.get("pid")):
            break
        time.sleep(0.25)
    if not st or not process_alive(st.get("pid")):
        die(f"supervisor 没起来，看 {SUPERVISOR_LOG}")

    out(f"已启动 supervisor pid={st.get('pid')}，Java pid={st.get('javaPid') or '启动中'}")
    if not wait_seconds:
        out("已转入后台；用 minecraft-server status 查看就绪状态")
        return
    out(f"等待 {connect_host()}:{server_port()} ...（首次启动会下载并打补丁，可能 5–15 分钟；之后十几秒）")
    deadline = time.time() + wait_seconds
    last_note = time.time()
    while time.time() < deadline:
        st = read_state()
        if not st or not process_alive(st.get("pid")):
            tail_txt = tail(SERVER_LOG, 20) or tail(SUPERVISOR_LOG, 20)
            die("服务进程退出了，日志：\n" + tail_txt)
        if port_open(connect_host(), server_port(), timeout=0.7):
            out(f"服务器已就绪：{address_display()}")
            out(f"本机 Java 客户端（需要自己的 Minecraft 账号）：直接连接 → {connect_host()}:{server_port()}")
            if not raw_server_ip():
                out("局域网：用这台手机的 IP 和上面的端口；确保 online-mode=true，建议 minecraft-server whitelist on")
            out("控制台：minecraft-server console list")
            return
        if time.time() - last_note > 15:
            last_note = time.time()
            line = last_log_line()
            out(f"仍在启动… {line}" if line else "仍在启动…")
        time.sleep(0.5)
    out(f"{wait_seconds} 秒内端口还没打开。首次启动的下载/打补丁可能要 5–15 分钟，服务仍在后台运行。")
    out(f"看日志：{SERVER_LOG}")
    out("状态：minecraft-server status；想多等一会儿用 start --wait 600")


def cmd_stop() -> None:
    st = read_state()
    if not st:
        orphans = find_java_pids()
        if orphans:
            out(f"没有状态文件，但发现 Java 进程 {orphans}；发送 SIGTERM")
            for pid in orphans:
                kill_pid(pid, 15)
            for _ in range(60):
                if not any(process_alive(p) for p in orphans):
                    break
                time.sleep(0.5)
            for pid in orphans:
                if process_alive(pid):
                    kill_pid(pid, 9)
            out("已清理")
        else:
            out("没有在运行")
        return
    sup_pid = st.get("pid")
    java_pid = st.get("javaPid")
    if not process_alive(sup_pid):
        if java_pid and process_alive(java_pid) and "paper.jar" in pid_cmdline(java_pid):
            out(f"supervisor 已退出，但 Java {java_pid} 还在；发送 SIGTERM")
            kill_pid(java_pid, 15)
            for _ in range(60):
                if not process_alive(java_pid):
                    break
                time.sleep(0.5)
            if process_alive(java_pid):
                kill_pid(java_pid, 9)
        clear_state()
        try:
            CONTROL_SOCK.unlink()
        except OSError:
            pass
        out("已清理旧状态")
        return

    try:
        control_send({"cmd": "stop"}, timeout=8)
        out("已发送 stop，等待服务器存档退出…")
    except (OSError, RuntimeError, ValueError) as e:
        out(f"控制套接字不可用（{e}），改发 SIGTERM")
        kill_pid(sup_pid, 15)

    deadline = time.time() + 90
    while time.time() < deadline and process_alive(sup_pid):
        time.sleep(0.5)
    if process_alive(sup_pid):
        out("90 秒内没退出，发送 SIGTERM")
        kill_pid(sup_pid, 15)
        deadline = time.time() + 15
        while time.time() < deadline and process_alive(sup_pid):
            time.sleep(0.5)
    if process_alive(sup_pid):
        out("仍在；发送 SIGKILL")
        kill_pid(sup_pid, 9)
    if java_pid and process_alive(java_pid):
        kill_pid(java_pid, 15)
        time.sleep(1)
        if process_alive(java_pid):
            kill_pid(java_pid, 9)
    clear_state()
    try:
        CONTROL_SOCK.unlink()
    except OSError:
        pass
    out("已停止")


def cmd_restart() -> None:
    cmd_stop()
    time.sleep(1)
    cmd_start([])


def cmd_status() -> None:
    st = read_state()
    out(f"数据目录：{DATA}")
    out(f"Paper：{PAPER_VERSION}（GPL-3.0）")
    out(f"EULA：{'已接受' if eula_accepted() else '未接受'}")
    out(f"配置监听：{address_display()}")
    if not st:
        out("状态：未运行")
        return
    if not process_alive(st.get("pid")):
        out("状态：状态文件是旧的（supervisor 已退出）；minecraft-server stop 可清理")
        return
    out(f"状态：运行中（supervisor pid {st.get('pid')}，Java pid {st.get('javaPid') or '启动中'}）")
    started = st.get("startedAt")
    try:
        uptime = time.time() - calendar.timegm(time.strptime(started, "%Y-%m-%dT%H:%M:%SZ"))
        out(f"运行时间：{human_uptime(uptime)}")
    except (TypeError, ValueError):
        pass
    out(f"日志：{SERVER_LOG}")
    line = last_log_line()
    if line:
        out(f"最后一行：{line}")


def cmd_console(args: list[str]) -> None:
    line = " ".join(args).strip()
    if not line:
        die("用法：minecraft-server console <命令...>，例如 console list")
    if "\n" in line or "\r" in line:
        die("命令里不能有换行")
    try:
        control_send({"cmd": "console", "line": line})
    except (OSError, RuntimeError, ValueError) as e:
        die(f"服务器没在运行或控制套接字不可用：{e}")
    out(f"已发送：{line}")
    time.sleep(0.4)
    txt = tail(SERVER_LOG, 8)
    if txt:
        out("--- 日志末尾 ---")
        out(txt)


def cmd_whitelist(args: list[str]) -> None:
    if not args:
        die("用法：minecraft-server whitelist on|off|list|add <名字>|remove <名字>")
    action = args[0].lower()
    if action in ("on", "off", "list"):
        line = f"whitelist {action}"
    elif action in ("add", "remove"):
        if len(args) < 2 or not re.fullmatch(r"[A-Za-z0-9_]{3,16}", args[1]):
            die("玩家名要是 3–16 位字母、数字或下划线")
        line = f"whitelist {action} {args[1]}"
    else:
        die("只支持 on / off / list / add / remove")
    try:
        control_send({"cmd": "console", "line": line})
    except (OSError, RuntimeError, ValueError) as e:
        die(f"服务器没在运行或控制套接字不可用：{e}")
    out(f"已发送：{line}")
    time.sleep(0.5)
    txt = tail(SERVER_LOG, 10)
    if txt:
        out("--- 日志末尾 ---")
        out(txt)
    out("提示：白名单改动已由服务器保存；不需要重启。")


def make_backup() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = BACKUP_DIR / ("world-" + time.strftime("%Y%m%d-%H%M%S") + ".tar.gz")
    names = ["world", "world_nether", "world_the_end", "server.properties", "ops.json", "whitelist.json", "banned-players.json", "banned-ips.json"]
    with tarfile.open(target, "w:gz") as tar:
        for name in names:
            p = DATA / name
            if p.exists():
                tar.add(p, arcname=name)
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    return target


def cmd_backup() -> None:
    _, running = server_running()
    try:
        if running:
            res = control_send({"cmd": "backup"}, timeout=600)
            if not res.get("ok"):
                die(res.get("error") or "备份失败")
            target = Path(str(res.get("path") or ""))
            out(f"备份完成：{target}")
        else:
            if not (DATA / "world").exists():
                die("world 目录还不存在（服务器还没生成世界），没有可备份的内容")
            target = make_backup()
            out(f"服务没在运行，直接打包：{target}")
        try:
            size = target.stat().st_size
            out(f"大小：{size / 1048576:.1f} MB")
        except OSError:
            pass
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as e:
        die(f"备份失败：{e}")


def cmd_logs(args: list[str]) -> None:
    n = 80
    if args:
        try:
            n = max(1, min(500, int(args[0])))
        except ValueError:
            die("行数要是数字")
    out(f"日志：{SERVER_LOG}（可能含玩家聊天；只在用户同意时查看）")
    txt = tail(SERVER_LOG, n)
    out(txt if txt else "（还没有日志）")


def cmd_config(args: list[str]) -> None:
    if not args or args[0] in ("get", "show"):
        out(f"数据目录：{DATA}")
        out(f"配置文件：{CONFIG_FILE}")
        out(f"server.properties：{SERVER_PROPS}")
        out(f"EULA：{'已接受' if eula_accepted() else '未接受'}")
        out(f"内存：{load_config()['memory']}")
        out(f"监听：{address_display()}")
        out(f"白名单：{whitelist_display()}")
        out(f"Paper：{PAPER_VERSION}")
        return
    if args[0] != "set" or len(args) < 3:
        die("用法：minecraft-server config set <memory|port|bind|whitelist> <值>")
    key, value = args[1], args[2]
    if key == "memory":
        try:
            cfg = load_config()
            cfg["memory"] = normalize_memory(value)
            save_config(cfg)
        except ValueError as e:
            die(str(e))
        out(f"内存已设为 {cfg['memory']}（下次 start 生效）")
        return
    if not SERVER_PROPS.exists():
        die("还没 setup，server.properties 不存在")
    if server_running()[1]:
        die("服务器在运行；先 minecraft-server stop 再改端口/绑定/白名单")
    if key == "port":
        try:
            port = int(value)
        except ValueError:
            die("端口要数字")
        if port < 1024 or port > 65535:
            die("端口要在 1024–65535 之间")
        set_property("server-port", str(port))
        out(f"server-port={port}")
    elif key == "bind":
        if value == "lan":
            set_property("server-ip", "")
            out("server-ip=（监听所有网卡；局域网可连，注意 online-mode 和白名单）")
        elif value == "loopback":
            set_property("server-ip", "127.0.0.1")
            out("server-ip=127.0.0.1（仅本机）")
        else:
            try:
                ipaddress.ip_address(value)
            except ValueError:
                die("bind 只能是 loopback / lan / 一个 IP 地址")
            set_property("server-ip", value)
            out(f"server-ip={value}")
    elif key == "whitelist":
        if value.lower() not in ("on", "off", "true", "false"):
            die("whitelist 只能是 on / off")
        on = value.lower() in ("on", "true")
        set_property("white-list", "true" if on else "false")
        out(f"white-list={'true' if on else 'false'}（下次 start 生效）")
    else:
        die("只支持 memory / port / bind / whitelist")


def cmd_selftest() -> None:
    checks: list[tuple[str, bool, str]] = []
    major, text = java_version()
    checks.append(("java", major is not None and major >= JAVA_MIN, text))
    paper_err = check_paper()
    checks.append(("paper", paper_err is None, paper_err or f"{PAPER_VERSION} sha256 OK"))
    jar_ok = False
    jar_msg = "jar 命令不存在"
    jar_bin = shutil.which("jar") or str(PREFIX / "bin" / "jar")
    if Path(jar_bin).exists() and PAPER_JAR.exists():
        try:
            p = subprocess.run([jar_bin, "tf", str(PAPER_JAR)], capture_output=True, text=True, timeout=30)
            jar_ok = p.returncode == 0 and "io/papermc/paperclip/Main.class" in p.stdout
            jar_msg = "Paperclip Main.class 可读" if jar_ok else (p.stderr or "jar 里找不到 Paperclip")[:200]
        except (OSError, subprocess.TimeoutExpired) as e:
            jar_msg = str(e)
    checks.append(("paperclip", jar_ok, jar_msg))

    props_ok = False
    props_msg = "写不了临时文件"
    tmp = None
    try:
        base = Path(os.environ.get("TMPDIR") or str(TMP_DIR))
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = Path(tempfile.mkdtemp(prefix="mc-selftest-", dir=str(base)))
        p = tmp / "server.properties"
        p.write_text("server-port=25565\nserver-ip=127.0.0.1\nwhite-list=true\n", encoding="utf-8")
        vals = parse_properties(p)
        props_ok = vals.get("server-port") == "25565" and vals.get("white-list") == "true"
        props_msg = "server.properties 解析正常" if props_ok else "解析结果不对"
    except OSError as e:
        props_msg = str(e)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    checks.append(("properties", props_ok, props_msg))

    for name, ok, msg in checks:
        out(f"{'OK' if ok else 'FAIL'}  {name}: {msg}")
    ok = all(c[1] for c in checks)
    out("===== 总结 ===== " + " ".join(f"{n}={'OK' if o else 'FAIL'}" for n, o, _ in checks))
    if not ok:
        raise SystemExit(1)


def cmd_version() -> None:
    major, text = java_version()
    out(f"minecraft-server · Paper {PAPER_VERSION} · {COMPONENT_DIR}")
    out(f"数据目录：{DATA}")
    out(f"Java：{text or '未找到'}" + (f"（major {major}）" if major else ""))
    cfg = load_config()
    out(f"内存：{cfg['memory']} · 监听：{address_display()} · 白名单：{whitelist_display()}")


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else None
    rest = args[1:]
    try:
        if cmd in (None, "help", "-h", "--help"):
            out(HELP)
        elif cmd == "setup":
            cmd_setup(rest)
        elif cmd == "start":
            cmd_start(rest)
        elif cmd == "stop":
            cmd_stop()
        elif cmd == "restart":
            cmd_restart()
        elif cmd == "status":
            cmd_status()
        elif cmd == "console":
            cmd_console(rest)
        elif cmd == "whitelist":
            cmd_whitelist(rest)
        elif cmd == "backup":
            cmd_backup()
        elif cmd == "logs":
            cmd_logs(rest)
        elif cmd == "config":
            cmd_config(rest)
        elif cmd == "selftest":
            cmd_selftest()
        elif cmd == "version":
            cmd_version()
        else:
            die(f"不认识的命令：{cmd}（看 minecraft-server help）")
    except KeyboardInterrupt:
        die("已取消", 130)


if __name__ == "__main__":
    main()
