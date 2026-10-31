#!/bin/bash
# 使用独立 HOME，CCR 的固定状态路径不会覆盖用户已有的路由器配置。
BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || return 1
export HOME="$BR/runtime-home"
STATE="$HOME/.claude-code-router"
CLI="$BR/node_modules/@musistudio/claude-code-router/dist/cli.js"
PIDFILE="$STATE/.claude-code-router.pid"
PORT=$(< "$BR/port") || return 1
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || return 1
URL="http://127.0.0.1:$PORT/health"
# 防止外部 SERVICE_PORT 意外覆盖安装时选定的端口。
export SERVICE_PORT="$PORT"
INTERVAL=${CCR_BRIDGE_INTERVAL:-5}
GRACE=${CCR_BRIDGE_GRACE:-15}
FAIL_LIMIT=${CCR_BRIDGE_FAIL_LIMIT:-3}
START_TIMEOUT=${CCR_BRIDGE_START_TIMEOUT:-65}
RECOVERY_LIMIT=${CCR_BRIDGE_RECOVERY_LIMIT:-3}
RECOVERY_STABLE=${CCR_BRIDGE_RECOVERY_STABLE:-300}
[[ "$RECOVERY_LIMIT" =~ ^[1-9][0-9]?$ && "$RECOVERY_STABLE" =~ ^[1-9][0-9]*$ ]] || return 1

bridge_log() {
  printf '[%s] %s %s\n' "$1" "$(date '+%F %T')" "$2" >> "$STATE/bridge.out"
}

# 只读本安装的元数据，不读取连接文件、上游配置或任何密钥。
bridge_component_present() {
  [[ ! -e "$BR/disabled" ]] || return 1
  node -e 'try { const fs=require("node:fs"), path=require("node:path"); const root=process.argv[1], m=JSON.parse(fs.readFileSync(path.join(root,".ccr-bridge-kit.json"),"utf8")); if(m.id!=="ccr-bridge-kit"||m.target!==root||typeof m.componentEntry!=="string"||!path.isAbsolute(m.componentEntry)||!fs.statSync(m.componentEntry).isFile()) process.exit(1); } catch { process.exit(1); }' "$BR" 2>/dev/null
}

# 不凭 PID 文件就杀进程：同时校验 Node、完整脚本路径（或原看护的相对路径 + cwd）。
bridge_process() {
  local pid=$1
  local -a args=()
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  { mapfile -d '' -t args < "/proc/$pid/cmdline"; } 2>/dev/null || return 1
  [[ ${#args[@]} -ge 3 && ${args[0]##*/} = node && ${args[2]} = start ]] || return 1
  [[ ${args[1]} = "$CLI" ]] && return 0
  [[ ${args[1]} = node_modules/@musistudio/claude-code-router/dist/cli.js ]] &&
    [[ $(readlink "/proc/$pid/cwd" 2>/dev/null) = "$BR" ]]
}

bridge_pid() {
  local pid
  [[ -r "$PIDFILE" ]] || return 1
  pid=$(< "$PIDFILE")
  bridge_process "$pid" || return 1
  printf '%s\n' "$pid"
}

bridge_healthy() {
  bridge_pid >/dev/null || return 1
  node "$BR/health.cjs" "$PORT" 2>/dev/null
}

watchdog_running() {
  local pid
  local -a args=()
  [[ -r "$STATE/watchdog.pid" ]] || return 1
  pid=$(< "$STATE/watchdog.pid")
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  { mapfile -d '' -t args < "/proc/$pid/cmdline"; } 2>/dev/null || return 1
  [[ ${#args[@]} -ge 2 && ${args[0]##*/} = bash && ${args[1]} = "$BR/watchdog.sh" ]] || return 1
  # PID 仍在但锁已释放，也不能算一个有效的看护。
  ! flock -n "$STATE/watchdog.lock" true
}

# 只在持有 service.lock 时调用。TERM 后限时等待，卡死才 KILL，并复核进程身份。
bridge_stop() {
  local pid=$1 stamp now rest
  local -a fields=()
  bridge_process "$pid" || return 0
  IFS= read -r rest < "/proc/$pid/stat" || return 1
  rest=${rest##*) }
  read -r -a fields <<< "$rest"
  stamp=${fields[19]}
  kill -TERM "$pid" 2>/dev/null || return 1
  for _ in {1..20}; do
    bridge_process "$pid" || break
    sleep 0.2
  done
  if bridge_process "$pid"; then
    IFS= read -r rest < "/proc/$pid/stat" || return 1
    rest=${rest##*) }
    read -r -a fields <<< "$rest"
    now=${fields[19]}
    [[ "$now" = "$stamp" ]] || return 1
    kill -KILL "$pid" 2>/dev/null || return 1
    for _ in {1..10}; do
      bridge_process "$pid" || break
      sleep 0.1
    done
  fi
  bridge_process "$pid" && return 1
  if [[ -r "$PIDFILE" && $(< "$PIDFILE") = "$pid" ]]; then
    rm -f -- "$PIDFILE"
  fi
  return 0
}
