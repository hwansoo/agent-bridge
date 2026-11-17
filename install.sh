#!/usr/bin/env bash
# agent-bridge 설치 스크립트 (macOS / Linux / WSL / Windows Git Bash)
#   curl -fsSL https://raw.githubusercontent.com/hwansoo/agent-bridge/main/install.sh | bash
#   ... | bash -s -- --with-msgr     # msgr(메시징)까지 설치
#   ... | bash -s -- --uninstall     # 위임 스킬 제거
# 기본 동작: 위임 스킬(opencode-delegate)을 ~/.claude/skills/ 에 설치한다. git/npm 불필요.
set -euo pipefail

REPO="hwansoo/agent-bridge"
REF="${AGENT_BRIDGE_REF:-main}"
BASE="${AGENT_BRIDGE_BASE:-https://raw.githubusercontent.com/$REPO/$REF}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST="$CLAUDE_DIR/skills/opencode-delegate"

with_msgr=0; uninstall=0
for a in "$@"; do
  case "$a" in
    --with-msgr) with_msgr=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help)
      echo "사용: install.sh [--with-msgr] [--uninstall]"
      echo "  (옵션 없음)   위임 스킬을 ~/.claude/skills/opencode-delegate 에 설치"
      echo "  --with-msgr   msgr도 ~/.agent-bridge 에 받아 빌드(도구 등록은 직접 setup 실행)"
      echo "  --uninstall   위임 스킬 제거"
      echo "  AGENT_BRIDGE_REF=<태그|브랜치> 로 특정 버전을 설치할 수 있습니다(기본 main)."
      exit 0 ;;
    *) echo "알 수 없는 옵션: $a" >&2; exit 2 ;;
  esac
done

if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then echo "HOME이 비정상입니다." >&2; exit 1; fi

if [ "$uninstall" = 1 ]; then
  rm -rf "$DEST"; echo "제거: $DEST"
  echo "msgr를 설치했다면: node <설치경로>/packages/msgr/dist/cli.js setup --uninstall"
  exit 0
fi

command -v curl >/dev/null || { echo "curl이 필요합니다." >&2; exit 1; }

echo "위임 스킬 설치 → $DEST"
mkdir -p "$DEST"
for f in SKILL.md delegate.sh .gitattributes; do
  curl -fsSL "$BASE/skills/opencode-delegate/$f" -o "$DEST/$f.tmp"
  mv "$DEST/$f.tmp" "$DEST/$f"
done
chmod +x "$DEST/delegate.sh"

command -v opencode >/dev/null || echo "! opencode가 PATH에 없습니다. 위임을 쓰려면 OpenCode를 먼저 설치하세요."
if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-delegate/model" ] && [ -z "${OPENCODE_DELEGATE_MODEL:-}" ]; then
  echo "  모델 지정(선택): echo 'provider/model' > ${XDG_CONFIG_HOME:-\$HOME/.config}/opencode-delegate/model"
fi

if [ "$with_msgr" = 1 ]; then
  for c in git node npm; do command -v "$c" >/dev/null || { echo "--with-msgr에는 $c 가 필요합니다." >&2; exit 1; }; done
  SRC="${AGENT_BRIDGE_HOME:-$HOME/.agent-bridge}"
  if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only -q; else git clone -q --depth 1 -b "$REF" "https://github.com/$REPO.git" "$SRC"; fi
  (cd "$SRC/packages/msgr" && npm ci --silent && npm run build --silent)
  echo "msgr 설치 위치: $SRC/packages/msgr"
  echo "도구에 등록하려면(설정 파일을 수정함): node $SRC/packages/msgr/dist/cli.js setup --dry-run  →  확인 후 setup"
fi
echo "완료. Claude Code를 재시작하면 스킬이 인식됩니다."
