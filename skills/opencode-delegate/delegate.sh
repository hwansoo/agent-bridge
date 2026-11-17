#!/usr/bin/env bash
# OpenCode에 작업을 위임하는 래퍼. 의존성: bash, grep, cut, sed, opencode (jq 불필요).
# 사용: delegate.sh <plan|build> [-m 모델] [-s 세션id] [-w 워크트리이름] [-y] [-t 제목] -- "지시문"
#   plan  = 읽기 전용(리서치, 리뷰, 분석)   build = 구현(파일 수정)
#   -m    모델(provider/model). 생략 시 $OPENCODE_DELEGATE_MODEL > ~/.config/opencode-delegate/model > OpenCode 기본 모델
#   -s    이전 결과의 SESSION 값으로 같은 세션에 후속 지시
#   -w    별도 git 워크트리에서 실행(메인 작업 트리 보호)
#   -y    OpenCode 권한 요청 자동 승인(--auto). 워크트리나 깨끗한 브랜치에서만 쓸 것
set -u

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; }

mode="${1:-}"
case "$mode" in plan|build) shift ;; *) usage; exit 2 ;; esac

model=""; session=""; worktree=""; auto=0; title=""
# 값이 필요한 옵션: 값이 없거나 다른 옵션이면 중단(그대로 두면 shift 2 실패로 무한 루프)
need() { if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then echo "$1 에는 값이 필요합니다." >&2; usage; exit 2; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    -m) need "$@"; model="$2"; shift 2 ;;
    -s) need "$@"; session="$2"; shift 2 ;;
    -w) need "$@"; worktree="$2"; shift 2 ;;
    -t) need "$@"; title="$2"; shift 2 ;;
    -y) auto=1; shift ;;
    --) shift; break ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage; exit 2 ;;
  esac
done
prompt="$*"
[ -n "$prompt" ] || { echo "지시문이 비어 있습니다." >&2; usage; exit 2; }

# 모델 결정: 인자 > 환경변수 > 설정 파일 > (없음 = OpenCode 기본 모델)
[ -n "$model" ] || model="${OPENCODE_DELEGATE_MODEL:-}"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode-delegate/model"
if [ -z "$model" ] && [ -f "$cfg" ]; then model="$(head -n 1 "$cfg" | tr -d '\r')"; fi

args=(run --agent "$mode" --format json --archived --title "${title:-delegate-$mode}")
[ -n "$model" ]    && args+=(-m "$model")
[ -n "$session" ]  && args+=(-s "$session")
[ -n "$worktree" ] && args+=(--worktree "$worktree")
[ "$auto" = 1 ]    && args+=(--auto)

# 로그(프롬프트와 결과 전체)는 사용자 전용 위치에 둔다. 공용 /tmp는 다른 사용자가 읽거나 가로챌 수 있다.
umask 077
dir="${OPENCODE_DELEGATE_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-delegate}"
if ! { mkdir -p "$dir" && chmod 700 "$dir"; }; then echo "로그 디렉터리를 만들 수 없습니다: $dir" >&2; exit 1; fi
# 오래된 로그 정리(기본 7일)
find "$dir" -type f \( -name '*.jsonl' -o -name '*.err' \) -mtime +"${OPENCODE_DELEGATE_LOG_DAYS:-7}" -delete 2>/dev/null
ts="$(date +%Y%m%d-%H%M%S)-$$"
log="$dir/$ts.jsonl"; err="$dir/$ts.err"

# stdin을 닫아(</dev/null) opencode가 입력을 기다리지 않게 한다. timeout이 있으면 적용(기본 30분).
if command -v timeout >/dev/null 2>&1; then
  timeout "${OPENCODE_DELEGATE_TIMEOUT:-1800}" opencode "${args[@]}" -- "$prompt" >"$log" 2>"$err" </dev/null
else
  opencode "${args[@]}" -- "$prompt" >"$log" 2>"$err" </dev/null
fi
rc=$?

sid="$(grep -o '"sessionID":"ses_[A-Za-z0-9]*"' "$log" 2>/dev/null | head -n 1 | cut -d'"' -f4)"
echo "EXIT=$rc"
echo "MODE=$mode"
echo "MODEL=${model:-<OpenCode 기본 모델>}"
echo "SESSION=${sid:-<없음>}"
echo "LOG=$log"
# 실패해도 오류가 stderr가 아니라 stdout의 JSON error 이벤트에 있을 수 있어 둘 다 보여준다
errs="$(grep '^{"type":"error"' "$log" 2>/dev/null | sed -E 's/.*"message":"([^"]*)".*/\1/' | head -n 5)"
if [ "$rc" -ne 0 ] || [ -n "$errs" ]; then
  echo "--- 오류 ---"
  [ -n "$errs" ] && echo "$errs"
  tail -n 20 "$err" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^$'
fi
echo "--- 최종 응답(JSON 이벤트 type=text, 마지막 3개) ---"
grep '^{"type":"text"' "$log" 2>/dev/null | tail -n 3 | cut -c1-6000
exit "$rc"
