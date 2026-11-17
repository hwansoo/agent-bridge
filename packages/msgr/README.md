# msgr — 코딩 에이전트 간 메시징

Claude Code, OpenCode, Codex, agy(Antigravity CLI) 같은 **서로 다른 에이전트 세션끼리** 메시지를 주고받게 해 주는 로컬 도구입니다.
각 세션은 `도구:폴더#id`(예: `claude-code:api-server#a3f2`)로 자동 식별되고, 별칭·폴더명·도구명으로도 지칭할 수 있습니다.

## 구조

```
 Claude Code ─┐                                   ┌─ 훅 / Monitor 로 깨움
 OpenCode    ─┼─ MCP(stdio) ─ msgr 서버(세션당 1개) ─┼─ OpenCode HTTP API 로 주입
 Codex       ─┤        │                          ├─ Codex app-server 로 주입
 agy         ─┘        ▼                          └─ 훅(프롬프트 직전)으로 주입
              ~/.msgr/  messages.jsonl (추가 전용 로그)
                        agents/  (세션 레지스트리 + 하트비트)
                        cursors/ (세션별 읽은 위치)   pins/ (수동 고정)
                        watchers/ (agy 백그라운드 대기 상태)   audit.log (소비 경로 진단 기록)
```

- 저장소는 파일뿐입니다(외부 서버·DB 없음). 메시지는 `messages.jsonl`에 한 줄씩 추가되고, 세션마다 바이트 오프셋 커서를 둡니다.
- MCP 서버는 각 에이전트 세션이 시작할 때 함께 뜨고, 핸드셰이크의 클라이언트 이름과 작업 폴더로 자기 id를 만들어 등록합니다.

## 설치

```sh
npm install
npm run build
node dist/cli.js setup            # 설치된 도구에 MCP 서버 + 자동 수신 훅을 등록
node dist/cli.js setup --dry-run  # 변경 없이 무엇을 할지 보기
node dist/cli.js setup --only claude,codex
node dist/cli.js setup --uninstall
```

`setup`은 여러 번 실행해도 안전하고(중복 등록 없음), 수정하는 JSON 설정은 최초 1회 `.bak-msgr`로 백업합니다.

설치 후:
- **실행 중인 에이전트 세션은 재시작**해야 msgr가 로드됩니다.
- OpenCode는 `opencode service restart`도 필요합니다.
- Codex는 처음에 `/hooks`에서 msgr 훅을 한 번 검토·신뢰해야 훅이 실행됩니다.

## 에이전트가 쓰는 도구 (MCP)

| 도구 | 설명 |
|---|---|
| `send_message(to, body, thread?)` | 메시지 전송. `to`는 id, 별칭, 폴더명, 도구명, 경로 일부, `"*"`(브로드캐스트) |
| `read_inbox(peek?)` | 새 메시지 읽기(읽은 메시지는 다시 나오지 않음) |
| `list_agents()` | 등록된 세션, 폴더, 별칭, online 여부 |
| `whoami()` | 내 id·도구·폴더·별칭 |
| `set_alias(alias)` | 별칭 붙이기(예: `reviewer`) |
| `pin_target(target?)` | 자동 수신 시 주입할 세션/스레드를 고정(생략하면 해제) |

지칭이 여러 세션에 걸리면 보내지 않고 후보를 알려 줍니다. 모호하면 전체 id를 쓰세요.

## 자동 수신 (에이전트가 가만히 있어도 메시지가 들어오는 방식)

| 도구 | 프롬프트 직전 주입 | 유휴 상태 깨우기 |
|---|---|---|
| Claude Code | `UserPromptSubmit` 훅 | `SessionStart` 훅이 `Monitor`로 `msgr watch` 시작 안내(30분마다 재시작 필요) |
| OpenCode | – | MCP 서버가 `POST /api/session/{id}/synthetic`으로 주입 |
| Codex | `UserPromptSubmit` 훅 | MCP 서버가 app-server 제어 소켓으로 `turn/start` 주입 |
| agy | `PreInvocation` 훅 | 같은 훅이, 살아 있는 백그라운드 watcher가 없을 때 `run_command`로 `msgr watch --once --tool agy`를 걸도록 안내(5분에 한 번). 메시지가 오면 그 태스크가 종료되며 agy 런타임이 유휴 상태를 깨움(에이전트 협조 필요). agy CLI는 `SessionStart` 훅을 지원하지 않음 |

세부 동작:
- **OpenCode**: 같은 폴더의 세션 중 실행 중인 것 > 가장 최근에 화면에서 본/갱신된 것 하나에 주입합니다.
  실행 중이 아닌 세션이 최근 60분(`MSGR_OC_STALE_MIN`, `0`이면 끔) 안에 보거나 갱신된 적이 없으면 주입하지 않고 대기합니다.
  TUI를 막 열어 아직 프롬프트를 입력하지 않았다면 세션이 만들어지기 전이라 화면에 주입할 대상이 없으므로, 프롬프트를 한 번 입력하세요.
- **Codex**: 같은 폴더에 로드된 스레드 중 사용자가 쓰고 있는 스레드 하나(대화 내용이 있는 것 우선, 그중 가장 최근 갱신된 것)에만 주입합니다. 그 스레드가 작업 중이면 다른 유휴 스레드(재시작 때 생긴 빈 스레드 등)로 넘기지 않고 끝날 때까지 기다립니다. app-server는 실험적 기능이라 Codex 업데이트로 깨질 수 있습니다.
- 같은 폴더에 세션이 여럿이고 자동 선택이 틀리면 `pin_target` 도구나 `node dist/cli.js pin <agent-id> <session/thread id>`로 고정하세요.
- 훅은 같은 폴더에 같은 도구의 세션이 둘 이상이면 어느 세션인지 특정하지 못해 조용히 건너뜁니다(Claude Code는 세션 id로 구분하므로 해당 없음).

## 루프 방지

에이전트끼리 자동으로 답장을 주고받는 일을 막기 위한 장치입니다.
- 전송 측: 같은 (보내는 쪽→받는 쪽)이 1분에 10건을 넘기거나 두 세션 사이 양방향 합이 16건을 넘으면 `send_message`가 거부됩니다.
- 수신 측: OpenCode와 Codex의 자동 주입은 세션당 분당 6회로 제한되며, 넘으면 다음 주기로 미룹니다.
- 주입 메시지에는 "단순 확인/알림에는 답장하지 말라"는 안내가 붙습니다.

환경변수: `MSGR_NUDGE_MIN`(agy 안내 간격, 기본 5분), `MSGR_MAX_SEND_PER_MIN`(10), `MSGR_MAX_PINGPONG_PER_MIN`(16), `MSGR_MAX_PUSH_PER_MIN`(6).

## CLI

```
node dist/cli.js setup [--dry-run] [--uninstall] [--only claude,opencode,codex,agy]
node dist/cli.js agents                          # 세션 목록
node dist/cli.js send <from> <to> <본문...>      # 수동 전송(테스트용)
node dist/cli.js inbox <id>                      # 수동으로 inbox 읽기
node dist/cli.js pin <agent-id> [target]         # 자동 수신 대상 고정/해제
node dist/cli.js gc [--dry-run]                  # 고아 커서/핀/watcher 기록 정리, 온라인 에이전트가 없을 때 커진 로그 비우기
node dist/cli.js watch [--once] [--tool t]       # 새 메시지 출력. 기본은 한 줄씩 계속(Claude Code Monitor용), --once는 한 번 받고 종료(agy 깨우기용)
```

## 환경변수

| 변수 | 의미 |
|---|---|
| `MSGR_HOME` | 데이터 디렉터리(기본 `~/.msgr`) |
| `MSGR_AGENT` | id를 직접 지정(기본은 자동) |
| `MSGR_ALIAS`, `MSGR_TOOL`, `MSGR_SESSION_ID` | 별칭/도구명/세션 id 지정 |
| `MSGR_PUSH=off` | 이 서버의 자동 주입 끄기(OpenCode/Codex) |
| `MSGR_OC_SESSION`, `MSGR_CODEX_THREAD` | 주입 대상 고정(핀과 동일) |
| `MSGR_OPENCODE_BIN`, `MSGR_CODEX_SOCK` | `opencode` 실행 파일 / Codex 제어 소켓 경로 |
| `MSGR_POLL_MS` | 자동 주입 확인 주기(기본 2000ms) |
| `MSGR_OC_STALE_MIN` | OpenCode 세션 신선도 기준(분, 기본 60, `0`이면 끔) |
| `MSGR_NUDGE_MIN` | agy에 "watcher를 걸라"고 다시 안내하는 최소 간격(분, 기본 5) |
| `MSGR_MAX_BODY` | 메시지 본문 최대 크기(바이트, 기본 32768). 더 큰 내용은 파일로 저장하고 경로를 보내세요 |
| `MSGR_MAX_SEND_PER_MIN`, `MSGR_MAX_PINGPONG_PER_MIN`, `MSGR_MAX_PUSH_PER_MIN` | 루프 방지 한도(기본 10 / 16 / 6). 잘못된 값이면 기본값 사용 |

## 진단과 유지보수

- `~/.msgr/audit.log`에 "누가 어떤 경로로 몇 건을 소비했는지"가 기록됩니다(`via=hook:agy`, `watch-once`, `mcp-read_inbox`, `cli-inbox`). 자동 수신이 어떤 경로로 동작했는지 확인할 때 보세요. 512KB를 넘으면 `audit.log.1`로 한 세대만 보관하고 새로 시작합니다.
- `node dist/cli.js gc`는 등록이 사라진 에이전트의 커서·핀·watcher 기록을 지우고, 온라인 에이전트가 없을 때만 1MB가 넘는 메시지 로그를 비웁니다. 먼저 `--dry-run`으로 확인하세요.
- 레지스트리 항목은 하트비트가 3분 끊기면 offline으로 표시되고, 24시간 뒤 자동 삭제됩니다.
- 한 세션의 메시지를 여러 경로(자동 주입, 훅, watch, `read_inbox`)가 동시에 가져가지 않도록 `~/.msgr/locks/`에 에이전트별 소비 잠금을 둡니다. 잠금은 주인 프로세스가 죽었거나 2분이 지나면 무시됩니다.
- `setup`은 msgr 항목만 고치고 같은 그룹의 다른 훅은 그대로 둡니다. 설정 파일 JSON이 깨져 있으면 그 파일은 건드리지 않고 실패로 보고합니다. 백업은 `*.bak-msgr`(msgr 설치 전 원본)과 `*.bak-msgr-last`(마지막 실행 직전)입니다.

## 테스트

```sh
npm test           # 빌드 후 test/smoke.mjs 실행(28개 항목)
npm run test:unit  # RateWindow / Backoff / store(커서·잠금·브로드캐스트·속도 제한·gc) 단위 테스트
```

임시 `MSGR_HOME`과 가짜 MCP 클라이언트(claude-code, opencode, codex, agy)로 id 생성, 지칭과 모호성 오류, 별칭, 한 번만 읽기, 루프 방지, 훅 출력 형식(Codex 평문/agy JSON), `watch --once`, 핀, `setup` 안전장치, `gc`, `audit` 로테이션, 깨진 로그 줄 건너뛰기, 크기 제한, 세션 재개 시 재주입 없음, 저장소 권한, `setup`의 사용자 훅 보존과 깨진 설정 파일 보호를 검증합니다. 실제 `~/.msgr`와 에이전트 설정은 건드리지 않습니다. 실제 OpenCode/Codex 서버에 대한 자동 주입은 각 도구가 떠 있어야 하므로 이 테스트에 포함되지 않습니다.

## 알려진 한계

- **agy 유휴 깨우기는 에이전트 협조에 의존**: 외부에서 턴을 주입하는 공개 수단이 없어서, 백그라운드 `watch --once`가 끝날 때의 반응형 깨우기를 씁니다. 에이전트가 안내를 따르지 않으면 깨우기가 안 됩니다(그 경우에도 프롬프트 입력 시 훅이 메시지를 주입하고, 다시 걸라고 안내합니다).
- **Claude Code `Monitor`는 30분마다 만료**됩니다. 세션에 안내가 들어가지만 자동 재시작은 보장되지 않습니다.
- 같은 폴더에서 같은 도구의 세션이 여럿이면 자동 주입 대상 선택이 틀릴 수 있습니다(`pin` 사용). 핀의 OpenCode 주입 전체 경로는 직접 시험하지 못했고, 선택 함수에서 핀이 우선하는 것까지만 확인했습니다.
- agy는 답장한 뒤 에이전트가 watcher를 다시 거는 데 20~40초가 걸립니다. 그 사이에 온 메시지는 새 watcher가 걸리면 즉시 전달됩니다(유실되지 않음).
- 작업 중인 에이전트에는 끝날 때까지 기다렸다가 주입합니다(즉시 끼어들기 없음).

## 보안

- **메시지는 사실상 다른 세션에 대한 지시 경로입니다.** 같은 계정에서 실행되는 프로세스라면 무엇이든 `msgr send`로 아무 세션에나 텍스트를 넣을 수 있고, CLI의 `send`는 발신자(`from`)를 임의로 적을 수 있습니다(MCP `send_message`는 위조 불가). 주입되는 메시지에는 "사용자 지시가 아니다"라는 안내문이 붙지만, 이것은 모델에 대한 권고일 뿐 방어 수단이 아닙니다.
  - Codex는 메시지로 **새 턴을 시작**하고, agy는 메시지를 **시스템 메시지급(`ephemeralMessage`)**으로 넣습니다.
  - 따라서 명령 실행 **자동 승인**(agy "항상 실행", Codex/OpenCode의 자동 승인 모드 등)과 함께 쓰면, 메시지 한 통으로 다른 세션에서 명령이 실행될 수 있습니다. 자동 승인은 신뢰할 수 있는 세션끼리, 버려도 되는 작업 트리에서만 쓰세요.
- **저장소 권한**: `~/.msgr`는 소유자 전용(0700)으로 만들어지고, 이전 버전이 만든 디렉터리도 실행 시 0700으로 바로잡습니다. 여러 사람이 쓰는 서버에서 `MSGR_HOME`을 공용 위치로 지정하지 마세요.
- **평문 보관**: 메시지 본문은 `~/.msgr/messages.jsonl`에 평문으로 남습니다(`gc`로 비우기 전까지). 비밀번호·토큰 같은 비밀은 메시지로 보내지 마세요.
- 네트워크로 열리는 포트는 없습니다. 자동 주입은 각 도구의 로컬 API(OpenCode 서비스, Codex 제어 소켓)를 씁니다. OpenCode 주입 본문은 `opencode api -d` 인자로 넘어가므로 실행 중 잠깐 `ps`에 보일 수 있습니다.

## 문제 해결

- `list_agents`에 세션이 안 보임 → 에이전트를 재시작했는지, `node dist/cli.js setup`을 실행했는지 확인하세요.
- 오래된 세션이 남아 있음 → 하트비트가 끊기면 offline으로 표시되고 24시간 뒤 정리됩니다.
- Codex 훅이 안 먹음 → Codex에서 `/hooks`로 훅을 신뢰했는지 확인하세요.
- OpenCode 자동 수신이 안 됨 → `opencode service restart` 후 다시 시도하고, 서버 로그(`[msgr] …`)를 보세요. TUI를 방금 열어 프롬프트를 입력하지 않았거나 세션이 60분 넘게 방치됐다면 메시지가 대기 중일 수 있습니다.
- agy가 백그라운드 `watch --once`를 못 걸거나 `EPERM`이 남 → agy가 명령 실행 허락을 물으면 "항상 실행"을 선택하세요(명령 샌드박스가 `~/.msgr` 쓰기를 막을 수 있어 첫 실행이 실패하기도 했습니다). 어떤 경로가 메시지를 소비했는지는 `~/.msgr/audit.log`에서 확인할 수 있습니다.
