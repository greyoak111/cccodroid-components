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
HEALTH_GRACE=${CCR_BRIDGE_HEALTH_GRACE:-300}
[[ "$HEALTH_GRACE" =~ ^[0-9]{1,4}$ ]] && (( 10#$HEALTH_GRACE <= 3600 )) || return 1
HEALTH_GRACE=$((10#$HEALTH_GRACE))
FAIL_LIMIT=${CCR_BRIDGE_FAIL_LIMIT:-3}
START_TIMEOUT=${CCR_BRIDGE_START_TIMEOUT:-65}
RECOVERY_LIMIT=${CCR_BRIDGE_RECOVERY_LIMIT:-3}
RECOVERY_STABLE=${CCR_BRIDGE_RECOVERY_STABLE:-300}
[[ "$RECOVERY_LIMIT" =~ ^[1-9][0-9]?$ && "$RECOVERY_STABLE" =~ ^[1-9][0-9]*$ ]] || return 1

bridge_log() {
  printf '[%s] %s %s\n' "$1" "$(date '+%F %T')" "$2" >> "$STATE/bridge.out"
}

# 只读非秘密元数据。0=完整，2=明确 disabled，3=仅固定入口暂缺，1=标记/路径无效。
# 只对 ENOENT 启动有限确认；链接、坏文件、路径/实例变化绝不按“更新中”放行。
bridge_component_state() {
  [[ ! -e "$BR/disabled" && ! -L "$BR/disabled" ]] || return 2
  node -e '
    const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
    try {
      const root=process.argv[1],file=path.join(root,".ccr-bridge-kit.json"),st=fs.lstatSync(file);
      if(!st.isFile()||st.nlink!==1||st.size>65536||fs.realpathSync(root)!==root)process.exit(1);
      const text=fs.readFileSync(file),m=JSON.parse(text);
      if(m.id!=="ccr-bridge-kit"||m.target!==root||typeof m.componentEntry!=="string"||!path.isAbsolute(m.componentEntry)||path.resolve(m.componentEntry)!==m.componentEntry)process.exit(1);
      const stamp=crypto.createHash("sha256").update(text).update(String(st.dev)+":"+st.ino).digest("hex");
      if(process.argv[2]&&process.argv[2]!==stamp)process.exit(1);
      console.log(stamp);
      let entry;try{entry=fs.lstatSync(m.componentEntry);}catch(error){if(error.code==="ENOENT")process.exit(3);throw error;}
      if(!entry.isFile()||entry.nlink!==1||fs.realpathSync(m.componentEntry)!==m.componentEntry)process.exit(1);
    } catch { process.exit(1); }
  ' "$BR" "${1:-}" 2>/dev/null
}
bridge_component_present() { bridge_component_state >/dev/null; }

# 市场更新先移除固定入口再铺文件；只有“入口 ENOENT + 原元数据身份未变”可等一次。
# 等待期间不修补、不停止/启动 CCR、不消费恢复预算；退出后绝不循环复活。
bridge_component_confirm() {
  local stamp rc deadline
  stamp=$(bridge_component_state "${1:-}"); rc=$?
  (( rc == 3 )) || return "$rc"
  bridge_log watchdog "固定组件入口暂缺，最多确认 10 秒；期间不重启"
  deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || return 1
    sleep 0.2
    bridge_component_state "$stamp" >/dev/null; rc=$?
    [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || return 1
    (( rc == 3 )) || return "$rc"
  done
  return 3
}

# 安卓经加载器执行时（termux-exec 的 linker 模式），/proc/PID/exe 是系统 linker，
# cmdline 是「原 argv0、真实程序绝对路径、原参数…」（真机实测）。exe 确是系统 linker 时
# 丢掉原 argv0，用 termux-exec 插进来的真实路径当程序，再照原规则比对（#66 第 2 项）
strip_linker() {
  local exe
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null) || return 0
  exe=${exe% (deleted)}   # apex 换版时旧 linker 已删
  # 标准 AOSP 上 /apex/com.android.runtime 是链接，exe 读出来带 @版本号
  [[ $exe = /system/bin/linker64 || $exe =~ ^/apex/com\.android\.runtime(@[^/]*)?/bin/linker64$ ]] && (( ${#args[@]} >= 2 )) && args=("${args[@]:1}")
  return 0
}

# 不凭 PID 文件就杀进程：同时校验 Node、完整脚本路径（或原看护的相对路径 + cwd）。
bridge_process() {
  local pid=$1
  local -a args=()
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  { mapfile -d '' -t args < "/proc/$pid/cmdline"; } 2>/dev/null || return 1
  strip_linker
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

# 只作跨解锁窗口的实例比较；PID + 内核启动时刻避免 PID 复用被当成原来的桥。
bridge_instance() {
  local pid rest
  local -a fields=()
  pid=$(bridge_pid) || return 1
  IFS= read -r rest < "/proc/$pid/stat" || return 1
  rest=${rest##*) }
  read -r -a fields <<< "$rest"
  [[ ${fields[19]:-} =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s\n' "$pid" "${fields[19]}"
}

bridge_healthy() {
  BRIDGE_HEALTH_RC=1
  if ! bridge_pid >/dev/null; then
    BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1
    return 1
  fi
  # 日志失效每轮只报一次固定诊断；须连续成功探活 300 秒才允许下一轮报告。
  # 任何失败（含 PID 消失）中断计时，不能靠故障持续时间或短暂成功反复刷屏。
  local diagnostic rc code
  local -a options=()
  [[ "${1:-}" = --diagnose ]] && options=(--diagnose)
  if (( ${BRIDGE_HEALTH_LOG_FAILED:-0} )); then
    node "$BR/health.cjs" "$PORT" --log "$STATE/health.log" "${options[@]}" 2>/dev/null; rc=$?
  else
    diagnostic=$(node "$BR/health.cjs" "$PORT" --log "$STATE/health.log" "${options[@]}" 2>&1); rc=$?
    if [[ -n "$diagnostic" ]]; then
      BRIDGE_HEALTH_LOG_FAILED=1
      while IFS= read -r code; do
        if [[ $code =~ ^\[[0-9TZ:.+-]+\]\ health\ ([A-Z][A-Z0-9_]*)$ ]]; then
          printf '%s\n' "$code" >&2
        fi
      done <<< "$diagnostic"
    fi
  fi
  if (( rc != 0 )); then
    BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1
  elif (( ${BRIDGE_HEALTH_LOG_FAILED:-0} )); then
    (( ${BRIDGE_HEALTH_LOG_HEALTHY_SINCE:--1} >= 0 )) || BRIDGE_HEALTH_LOG_HEALTHY_SINCE=$SECONDS
    if (( SECONDS - BRIDGE_HEALTH_LOG_HEALTHY_SINCE >= 300 )); then
      BRIDGE_HEALTH_LOG_FAILED=0
      BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1
    fi
  fi
  BRIDGE_HEALTH_RC=$rc
  return "$rc"
}

watchdog_running() {
  local pid
  local -a args=()
  [[ -r "$STATE/watchdog.pid" ]] || return 1
  pid=$(< "$STATE/watchdog.pid")
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  { mapfile -d '' -t args < "/proc/$pid/cmdline"; } 2>/dev/null || return 1
  strip_linker
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
