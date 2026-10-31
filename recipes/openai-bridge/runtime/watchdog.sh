#!/bin/bash
# 持续探活，而不是前台等待 Node；退出看护本身不会中断正在运行的桥。
umask 077
BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
source "$BR/bridge-common.sh" || exit 1
unset CCAPP_RUN CLAUDECODE CLAUDE_CODE_ENTRYPOINT
mkdir -p "$STATE" || exit 1
cd "$BR" || exit 1
exec 8> "$STATE/watchdog.lock" || exit 1
flock -n 8 || exit 0
printf '%s\n' "$$" > "$STATE/watchdog.pid" || exit 1

cleanup() {
  if [[ -r "$STATE/watchdog.pid" && $(< "$STATE/watchdog.pid") = "$$" ]]; then
    rm -f -- "$STATE/watchdog.pid"
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP

FAILURES=0
FAILED_SINCE=$SECONDS
LAST_START=$((-GRACE))
HEALTHY_SINCE=-1
ATTEMPTS=0
if [[ -r "$STATE/recovery.attempts" ]]; then
  ATTEMPTS=$(< "$STATE/recovery.attempts")
  [[ "$ATTEMPTS" =~ ^[0-9]{1,3}$ ]] || ATTEMPTS=$RECOVERY_LIMIT
fi
[[ ! -e "$STATE/recovery.failed" ]] || exit 1
exec 7> "$STATE/service.lock" || exit 1
while :; do
  [[ ! -e "$STATE/recovery.failed" ]] || exit 1
  if ! bridge_component_present; then
    printf 'component removed or disabled\n' > "$STATE/recovery.failed"
    bridge_log watchdog "组件已卸载或安装标记无效；不再重启，请用私有副本 uninstall.sh 清理"
    exit 0
  fi
  if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
    FAILURES=0
    FAILED_SINCE=$SECONDS
    (( HEALTHY_SINCE >= 0 )) || HEALTHY_SINCE=$SECONDS
    if (( ATTEMPTS > 0 && SECONDS - HEALTHY_SINCE >= RECOVERY_STABLE )); then
      ATTEMPTS=0
      rm -f -- "$STATE/recovery.attempts"
    fi
    sleep "$INTERVAL"
    continue
  fi
  HEALTHY_SINCE=-1

  ((FAILURES++))
  PID=$(bridge_pid) || PID=
  if [[ ! -e "$STATE/restart.request" ]]; then
    # 留出启动宽限；连续失败才重启，避免短暂调度延迟就误杀正在推理的桥。
    if (( SECONDS - LAST_START < GRACE )) ||
      { [[ -n "$PID" ]] && (( FAILURES < FAIL_LIMIT || SECONDS - FAILED_SINCE < GRACE )); }; then
      sleep "$INTERVAL"
      continue
    fi
  fi

  if ! flock -n 7; then
    sleep 0.2
    continue
  fi
  if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
    flock -u 7
    continue
  fi

  if (( ATTEMPTS >= RECOVERY_LIMIT )); then
    printf 'recovery limit reached\n' > "$STATE/recovery.failed"
    bridge_log watchdog "自动恢复已停止：连续启动/修补尝试达到 $RECOVERY_LIMIT 次，需排查后显式重置"
    flock -u 7
    exit 1
  fi
  ((ATTEMPTS++))
  printf '%s\n' "$ATTEMPTS" > "$STATE/recovery.attempts.tmp"
  mv -f -- "$STATE/recovery.attempts.tmp" "$STATE/recovery.attempts" || exit 1
  LAST_START=$SECONDS

  # 独立重拉时也必须先验证补丁，升级覆盖或补丁失败不能悄悄启动旧代码。
  timeout --kill-after=2 10 node "$BR/patch-ccr.js" >> "$STATE/start.log" 2>&1
  PATCHED=$?
  if [[ "$PATCHED" != 0 && "$PATCHED" != 2 ]]; then
    bridge_log watchdog "patch failed ($PATCHED); see $STATE/start.log"
    flock -u 7
    sleep "$INTERVAL"
    continue
  fi

  PID=$(bridge_pid) || PID=
  if [[ -n "$PID" ]]; then
    bridge_log watchdog "restarting bridge PID $PID after patch or repeated health failures"
    if ! bridge_stop "$PID"; then
      bridge_log watchdog "could not safely stop PID $PID; not starting a duplicate"
      flock -u 7
      sleep "$INTERVAL"
      continue
    fi
  elif [[ -r "$PIDFILE" ]]; then
    # 重启设备后 PID 会被复用；只清理已经核实不属于桥的旧记录，绝不杀无关进程。
    STALE=$(< "$PIDFILE")
    bridge_log watchdog "discarding stale or unrelated PID record: $STALE"
    rm -f -- "$PIDFILE"
  fi

  if ! bridge_component_present; then
    bridge_log watchdog "组件已卸载或安装标记无效；取消本次启动，请用私有副本 uninstall.sh 清理"
    exit 0
  fi
  # 两个锁 FD 绝不能传给常驻子进程；否则看护退出后单例锁仍无法释放。
  bridge_log watchdog "starting bridge"
  setsid env -u CCAPP_RUN -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    node "$CLI" start >> "$STATE/bridge.out" 2>&1 < /dev/null 7>&- 8>&- &
  rm -f -- "$STATE/restart.request"
  LAST_START=$SECONDS
  FAILED_SINCE=$SECONDS
  FAILURES=0
  flock -u 7
  sleep "$INTERVAL"
done
