#!/bin/bash
# Hook 只投递后台启动；手动 start 保留明确的就绪检查。
umask 077
BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
HOOK_MODE=0
if [[ "${1:-}" == "--hook" ]]; then
  HOOK_MODE=1
  PORT=$(< "$BR/port") || exit 0
  [[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || exit 0
  # 匹配完整 authority 边界；App 自定义接口可能先经本机 streamfix 包装。
  ENDPOINT=${ANTHROPIC_BASE_URL:-}
  case "$ENDPOINT" in
    "http://127.0.0.1:$PORT"|"http://127.0.0.1:$PORT/"*) ;;
    *)
      (( ${#ENDPOINT} <= 8192 )) || exit 0
      WRAPPER_RE='^http://127\.0\.0\.1:([0-9]{1,5})/u/([0-9a-f]{32}/)?([A-Za-z0-9_-]+)/?$'
      [[ "$ENDPOINT" =~ $WRAPPER_RE ]] || exit 0
      WRAPPER_PORT=${BASH_REMATCH[1]}
      TOKEN=${BASH_REMATCH[3]}
      (( 10#$WRAPPER_PORT >= 1 && 10#$WRAPPER_PORT <= 65535 )) || exit 0
      command -v base64 >/dev/null 2>&1 || exit 0
      ENCODED=${TOKEN//-/+}
      ENCODED=${ENCODED//_/\/}
      case $(( ${#ENCODED} % 4 )) in
        0) ;;
        2) ENCODED+='==' ;;
        3) ENCODED+='=' ;;
        *) exit 0 ;;
      esac
      # 保留尾部换行；回编码同时排除 NUL 丢失和非规范 base64，不能误启其他目标。
      { ENDPOINT=$( { printf '%s' "$ENCODED" | base64 -d || exit 1; printf '.'; } ); } 2>/dev/null || exit 0
      ENDPOINT=${ENDPOINT%.}
      ENCODED=$(printf '%s' "$ENDPOINT" | base64) || exit 0
      ENCODED=${ENCODED//$'\n'/}
      ENCODED=${ENCODED//+/-}
      ENCODED=${ENCODED//\//_}
      ENCODED=${ENCODED%%=*}
      [[ "$ENCODED" = "$TOKEN" ]] || exit 0
      case "$ENDPOINT" in
        "http://127.0.0.1:$PORT"|"http://127.0.0.1:$PORT/"*) ;;
        *) exit 0 ;;
      esac
      ;;
  esac
elif (( $# )); then
  printf '[start-bridge] 未知启动参数\n' >&2
  exit 1
fi
source "$BR/bridge-common.sh" || exit 1
unset CCAPP_RUN CLAUDECODE CLAUDE_CODE_ENTRYPOINT
mkdir -p "$STATE" || exit 1
LOG="$STATE/start.log"
STARTED=$SECONDS

fail() {
  printf '[start-bridge] %s\n' "$*" | tee -a "$LOG" >&2
  exit 1
}

for cmd in node flock setsid timeout; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令：$cmd"
done
if ! bridge_component_present; then
  printf '[start-bridge] 组件已卸载或安装标记无效；请用私有副本 uninstall.sh 清理\n' >> "$LOG"
  (( HOOK_MODE )) && exit 0
  fail "组件入口不存在或安装标记无效，未启动服务"
fi
[[ -r "$CLI" && -r "$BR/watchdog.sh" ]] || fail "桥文件不完整：$BR"
if [[ -e "$STATE/recovery.failed" ]]; then
  (( HOOK_MODE )) && exit 0
  fail "自动恢复达到上限，排查后需显式 start --reset-recovery --yes"
fi

# 看护自己持有单例锁并在启动 CCR 前校验补丁；Hook 不等锁、补丁或 HTTP 就绪。
if (( HOOK_MODE )); then
  setsid env -u CCAPP_RUN -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    bash "$BR/watchdog.sh" >> "$STATE/bridge.out" 2>&1 < /dev/null &
  exit 0
fi

exec 9> "$STATE/start.lock" || fail "无法打开启动锁"
flock -w 10 9 || fail "等待其他启动检查超时"
if ! watchdog_running; then
  for PROC in /proc/[0-9]*/cmdline; do
    ARGS=()
    { mapfile -d '' -t ARGS < "$PROC"; } 2>/dev/null || continue
    if [[ ${#ARGS[@]} -ge 2 && ${ARGS[0]##*/} = bash && ${ARGS[1]} = "$BR/watchdog.sh" ]]; then
      sleep 0.2
      watchdog_running || fail "发现尚未迁移的看护（${PROC%/cmdline}），需先确认并替换旧看护"
      break
    fi
  done
fi
exec 7> "$STATE/service.lock" || fail "无法打开服务锁"
flock -w 10 7 || fail "等待看护操作超时"
timeout --kill-after=2 10 node "$BR/patch-ccr.js" >> "$LOG" 2>&1
PATCHED=$?
case "$PATCHED" in
  0) ;;
  2) touch "$STATE/restart.request" || fail "无法记录补丁重启请求" ;;
  *) printf 'patch verification failed\n' > "$STATE/recovery.failed"; fail "补丁检查失败（退出码 $PATCHED），自动恢复已停止，详情：$LOG" ;;
esac
flock -u 7
exec 7>&-
flock -u 9
exec 9>&-

DEADLINE=$((STARTED + START_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  [[ ! -e "$STATE/recovery.failed" ]] || fail "自动恢复达到上限，请检查运行状态并显式重置"
  bridge_component_present || fail "等待就绪期间组件已卸载或停用"
  if watchdog_running; then
    if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
      exit 0
    fi
  elif flock -n "$STATE/watchdog.lock" true; then
    setsid env -u CCAPP_RUN -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
      bash "$BR/watchdog.sh" >> "$STATE/bridge.out" 2>&1 < /dev/null &
  fi
  sleep 0.2
done
fail "桥或看护在 ${START_TIMEOUT}s 内未就绪，详情：$STATE/bridge.out"
