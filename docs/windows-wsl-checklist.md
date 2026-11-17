# 위임 스킬: Windows(Git Bash) / WSL 검증 체크리스트

macOS에서만 검증된 `opencode-delegate`를 Windows·WSL에서 확인하는 절차입니다. 환경마다(Windows, WSL) 따로 설치하고 따로 확인하세요. 홈 디렉터리가 서로 다릅니다.
각 단계의 결과를 이슈로 남기면 SKILL.md에 반영할 수 있습니다.

## 0. 설치

```sh
curl -fsSL https://raw.githubusercontent.com/hwansoo/agent-bridge/main/install.sh | bash
```
Windows에서는 **Git Bash**에서 실행합니다(PowerShell/cmd 아님).

## 1. 사전 조건

| # | 확인 | 명령 | 기대 |
|---|---|---|---|
| 1 | opencode가 bash에서 보임 | `command -v opencode && opencode --version` | 경로와 버전 출력 |
| 2 | 스킬 파일 존재 | `ls ~/.claude/skills/opencode-delegate` | SKILL.md, delegate.sh |
| 3 | 줄바꿈이 LF | `file ~/.claude/skills/opencode-delegate/delegate.sh` | CRLF가 **없어야** 함 |
| 4 | `timeout` 사용 가능 | `command -v timeout` | 없으면 시간 제한 없이 실행됨(경고만) |
| 5 | 모델 설정 | `cat ~/.config/opencode-delegate/model` | 사내 모델 이름 |

> Git Bash의 `~`는 `C:\Users\<이름>`입니다. Claude Code(Windows)가 읽는 `~/.claude`와 같은 곳인지 확인하세요.

## 2. 동작 확인 (빈 임시 git 저장소에서)

```sh
d=$(mktemp -d) && cd "$d" && git init -q && echo "hello" > a.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm init
bash ~/.claude/skills/opencode-delegate/delegate.sh plan -t check -- "a.txt의 내용을 한 줄로 알려줘. 파일은 수정하지 마."
```

| # | 기대 결과 | 실패 시 의심 |
|---|---|---|
| 6 | `session:` 줄과 최종 답(“hello”)이 출력됨 | 모델 이름 오류, 로그인/키 미설정 |
| 7 | 에러가 나면 `error:` 줄로 원인이 보임 | opencode 버전 차이 |
| 8 | build 모드 + 워크트리: `delegate.sh build -w "$d-wt" -- "b.txt를 만들어"` 후 `git -C "$d-wt" status`에 b.txt | 워크트리 경로(Windows 경로 형식) |
| 9 | `git -C "$d-wt" diff \| git apply`로 결과 가져오기 | CRLF 변환(`core.autocrlf`) |

## 3. Claude Code에서 스킬 트리거

새 세션에서 “OpenCode에 시켜서 …를 구현해 줘”라고 요청해 스킬이 로드되고 `delegate.sh`가 호출되는지 확인합니다.

## 4. 알려진 위험

- WSL에서 Windows 쪽 `opencode.exe`가 PATH에 잡히면 경로 변환 문제가 생길 수 있습니다. WSL 안에 별도로 설치하는 편이 안전합니다.
- Git Bash에서 `timeout`은 GNU 버전이 아니라 Windows `timeout.exe`로 잡힐 수 있습니다. 4번 결과가 이상하면 알려 주세요.
- 프로젝트가 `/mnt/c/...`에 있으면(WSL) 파일 I/O가 느립니다.
