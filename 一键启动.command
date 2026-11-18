#!/bin/bash
# DataMind 数据分析 Agent —— 一键启动本地服务（双击即可运行）
set -u

# 切换到脚本所在目录（macOS 双击 .command 时工作目录不一定是这里）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=8080
HOST=127.0.0.1
PID_FILE="$SCRIPT_DIR/.server.pid"
LOG_FILE="$SCRIPT_DIR/.server.log"

echo "============================================"
echo " DataMind 数据分析 Agent · 本地服务启动"
echo "============================================"

# 1) 已有有效 PID 且进程存活，视为已启动，不重复拉起
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "服务已在运行（PID: ${OLD_PID}）。"
    echo "访问地址: http://${HOST}:${PORT}/"
    exit 0
  fi
fi

# 2) 端口被其它进程占用，不强行接管，避免冲突
if command -v lsof >/dev/null 2>&1; then
  OCCUPY="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null | head -n1)"
  if [ -n "${OCCUPY}" ]; then
    echo "端口 ${PORT} 已被其它进程占用（PID: ${OCCUPY}），本次不启动。"
    echo "请先运行「一键停止.command」，或确认该进程后可手动关闭。"
    exit 1
  fi
fi

# 3) 后台启动静态服务
nohup python3 -m http.server "${PORT}" --bind "${HOST}" > "${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"

# 4) 启动结果校验
sleep 1
if kill -0 "${NEW_PID}" 2>/dev/null; then
  echo "启动成功。"
  echo "访问地址: http://${HOST}:${PORT}/"
  echo "进程 PID : ${NEW_PID}"
  echo "日志文件 : ${LOG_FILE}"
else
  echo "启动失败，请查看日志: ${LOG_FILE}"
  rm -f "${PID_FILE}"
  exit 1
fi

echo "（关闭此窗口不会影响后台服务；停止请双击「一键停止.command」）"
