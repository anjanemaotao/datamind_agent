#!/bin/bash
# DataMind 数据分析 Agent —— 一键停止本地服务（双击即可运行）
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=8080
PID_FILE="$SCRIPT_DIR/.server.pid"

echo "============================================"
echo " DataMind 数据分析 Agent · 本地服务停止"
echo "============================================"

# 安全校验：仅停止确属本项目 http.server 的进程，避免误杀其它服务
is_our_server() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  if [ -n "${cmd}" ]; then
    echo "${cmd}" | grep -q "http.server" && echo "${cmd}" | grep -q "python" && return 0
    return 1
  fi
  # ps 不可用时的兜底：该 PID 是否为本项目专属端口的监听者
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null | grep -qx "${pid}" && return 0
  fi
  return 1
}

stopped=0

# 1) 优先按 PID 文件停止
if [ -f "${PID_FILE}" ]; then
  PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    if is_our_server "${PID}"; then
      kill "${PID}" 2>/dev/null && { echo "已停止服务（PID: ${PID}）。"; stopped=1; }
    else
      echo "PID ${PID} 不是本项目的静态服务，已跳过以免误杀。"
    fi
  fi
  rm -f "${PID_FILE}"
fi

# 2) 再按端口兜底：处理残留或 PID 文件丢失的情况
if command -v lsof >/dev/null 2>&1; then
  FOUND="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
  for p in ${FOUND}; do
    if is_our_server "${p}"; then
      kill "${p}" 2>/dev/null && { echo "已清理残留服务（PID: ${p}）。"; stopped=1; }
    else
      echo "端口 ${PORT} 上的 PID ${p} 非本项目服务，已跳过。"
    fi
  done
fi

if [ "${stopped}" -eq 1 ]; then
  echo "服务已停止。"
else
  echo "未发现运行中的本项目服务（可能已停止）。"
fi
