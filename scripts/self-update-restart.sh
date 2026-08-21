#!/usr/bin/env bash
# ============================================================================
# self-update-restart.sh — Craft Agent 后端自主更新重启脚本（Linux）
#
# 设计目标：AI agent 可在【会话内部】安全触发自身宿主的重启，实现全自动更新：
#   构建新 dist → 本脚本脱离进程树后台运行 → 延迟后 kill 旧进程
#   → supervisord ([program:craft-agent], autorestart=true) 自动拉起新进程
#   → 新进程加载新构建的代码 → 健康检查确认恢复
#
# 为什么需要脱离进程树：agent 的会话寄生在后端进程里。若在会话内直接 pkill，
# 会话随宿主一起死亡，后续命令永远不会执行。本脚本通过 setsid 挂到 init 下，
# 宿主死亡不影响它继续工作。
#
# 用法（在 agent 会话内执行）：
#   setsid nohup bash /tmp/craft-agents-tmp/scripts/self-update-restart.sh \
#       [延迟秒数，默认20] >> /tmp/craft-self-update.log 2>&1 &
#
# ⚠️ 前提：调用前必须已完成源码同步和 dist 构建！本脚本只负责"切换"，不负责"构建"。
# ============================================================================

set -u

DELAY="${1:-20}"                      # 延迟秒数：给当前会话留出发送最后消息的时间
LOG=/tmp/craft-self-update.log
RPC_HOST=127.0.0.1
RPC_PORT=9100                         # WebSocket RPC 端口（见 updating-craft-agent.md）
MAX_WAIT_CYCLES=60                    # 每 cycle 2s，即最多等 120s

# 精确锚定后端主进程：以 bun 二进制路径开头、完整 cmdline 结尾。
# 防止误杀 cmdline 中恰好包含该字符串的无关进程（如其他会话的 grep/tail）。
TARGET_PATTERN='^/root/.bun/bin/bun run packages/server/src/index.ts$'

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

log "=== self-update-restart triggered (delay=${DELAY}s) ==="

sleep "$DELAY"

# --- 1. 定位旧进程 ---
PIDS=$(pgrep -f "$TARGET_PATTERN" || true)
if [ -z "$PIDS" ]; then
    log "❌ 未找到后端进程 (pattern: $TARGET_PATTERN)，放弃。可能已被重启过？"
    exit 1
fi
N=$(echo "$PIDS" | wc -l)
if [ "$N" -gt 1 ]; then
    log "⚠️ 匹配到 $N 个进程 ($PIDS)，预期 1 个，放弃以免误杀。"
    exit 1
fi
OLD_PID="$PIDS"
log "target PID=$OLD_PID, sending TERM..."

# --- 2. 杀死旧进程（supervisord autorestart=true 将自动拉起）---
kill "$OLD_PID"

# 等待进程真正退出
for _ in $(seq 1 15); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
done
if kill -0 "$OLD_PID" 2>/dev/null; then
    log "TERM 未生效，发送 KILL"
    kill -9 "$OLD_PID"
fi
log "old process gone; waiting for supervisord to respawn..."

# --- 3. 健康检查：轮询 RPC 端口直到恢复 ---
for i in $(seq 1 "$MAX_WAIT_CYCLES"); do
    sleep 2
    if python3 - "$RPC_HOST" "$RPC_PORT" <<'PYEOF'
import socket, sys
s = socket.socket()
s.settimeout(2)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
    sys.exit(0)
except Exception:
    sys.exit(1)
PYEOF
    then
        NEW_PID=$(pgrep -f "$TARGET_PATTERN" | head -1)
        log "✅ server recovered after ~$((i * 2))s (new PID=$NEW_PID) — self-update complete"
        exit 0
    fi
done

log "❌ server 未在 $((MAX_WAIT_CYCLES * 2))s 内恢复——请人工检查:"
log "   tail -50 /tmp/craft-server.err.log"
log "   ps aux | grep packages/server"
exit 1
