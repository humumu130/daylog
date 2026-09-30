#!/bin/sh
# ============================================================
# provider-sample.sh —— AI 工具存储格式采样器（只读、零数据外带）
#
# 用途：在装有目标 AI 工具的机器上运行，导出「目录结构 + 数据库 schema」，
# 供日迹(Daylog)采集适配器(P5b)开发定解析方案。公司 Windows 机用 Git Bash
# 或 WSL 运行；macOS/Linux 直接运行。
#
# 隐私铁律：只导出目录树、文件名、大小与 SQLite 的 DDL（建表语句），
# 绝不导出任何表内容/会话正文/凭据——样本可以放心带回。
#
# 用法：
#   sh provider-sample.sh > sample-报告.txt
#   sh provider-sample.sh /额外/自定义/根目录 >> sample-报告.txt
# ============================================================

label() { printf '\n========== %s ==========\n' "$1"; }

# 候选存储根（按工具×平台罗列；存在才扫，不存在自动跳过）
roots_mac="/Users/$USER/Library/Application Support/Cursor/User/workspaceStorage"
roots_win1="$APPDATA/Cursor/User/workspaceStorage"
roots_win2="$(echo "$LOCALAPPDATA" | sed 's|\\|/|g')/Cursor/User/workspaceStorage"
trae_mac="/Users/$USER/Library/Application Support/Trae/User/workspaceStorage"
trae_win="$APPDATA/Trae/User/workspaceStorage"
buddy_win="$APPDATA/CodeBuddy"
wbuddy_win="$APPDATA/WorkBuddy"

ALL="$roots_mac $trae_mac $buddy_win $wbuddy_win $roots_win1 $roots_win2 $trae_win $*"

label "环境"
echo "时间: $(date '+%F %T')  主机: $(hostname)  系统: $(uname -s)"

for root in $ALL; do
  [ -d "$root" ] || continue
  label "$root"
  echo "--- 目录概览（顶层 30 项）---"
  ls -1 "$root" 2>/dev/null | head -30
  echo "--- 大小分布 ---"
  du -sh "$root" 2>/dev/null | head -1
  echo "--- 目录树（深度 3，仅目录名与关键扩展名）---"
  find "$root" -maxdepth 3 \( -name '*.vscdb' -o -name '*.sqlite' -o -name '*.db' -o -name '*.jsonl' -o -name '*.json' -o -type d \) 2>/dev/null | head -80
  # 逐个 SQLite 只导 schema（DDL），零行数据
  echo "--- SQLite schema（仅建表语句，无数据）---"
  find "$root" -maxdepth 4 \( -name '*.vscdb' -o -name '*.sqlite' -o -name '*.db' \) 2>/dev/null | head -6 | while read -r db; do
    echo "### $db ($(du -h "$db" | cut -f1))"
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 -readonly "$db" '.schema' 2>&1 | head -60
      echo "-- 表行数概览（仅计数）--"
      sqlite3 -readonly "$db" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null | while read -r t; do
        printf '  %s: %s 行\n' "$t" "$(sqlite3 -readonly "$db" "SELECT count(*) FROM \"$t\"" 2>/dev/null)"
      done
    else
      echo "(无 sqlite3，跳过 schema；文件特征已记录)"
    fi
  done
done

label "完成"
echo "把本输出整份带回即可（无任何隐私内容）。若目标工具不在此列表，"
echo "把它的安装/数据目录作为参数传入再跑一次：sh provider-sample.sh /path/to/data"
