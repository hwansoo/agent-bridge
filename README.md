# agent-bridge

코딩 에이전트(Claude Code, OpenCode, Codex, agy)를 서로 연결해 쓰기 위한 도구 모음입니다.

| 구성 요소 | 하는 일 | 상태 |
|---|---|---|
| [`skills/opencode-delegate`](skills/opencode-delegate) | Claude Code 같은 비싼 모델로 설계한 뒤, 구현·리서치를 OpenCode의 저렴한 모델에 위임하는 스킬 | macOS에서 검증. Windows(Git Bash)/WSL은 미검증 |
| [`packages/msgr`](packages/msgr) | 실행 중인 에이전트 세션끼리 메시지를 주고받는 MCP 서버 + CLI | macOS에서 4개 도구 모두 검증. Windows/Linux 미검증 |

두 구성 요소는 서로 독립적입니다. 필요한 것만 쓰면 됩니다.

## 위임 스킬 설치

macOS / Linux / WSL / Windows(Git Bash):

```sh
curl -fsSL https://raw.githubusercontent.com/hwansoo/agent-bridge/main/install.sh | bash
```

제거는 `... | bash -s -- --uninstall`, msgr까지 설치하려면 `... | bash -s -- --with-msgr`(설정 파일은 건드리지 않고, 등록은 `setup --dry-run`으로 확인한 뒤 직접 실행). 스크립트를 먼저 읽어 보고 싶다면 [install.sh](install.sh)를 확인하세요. 특정 버전을 받으려면 `curl ... | AGENT_BRIDGE_REF=<태그> bash`처럼 지정합니다.

Windows/WSL 검증 절차: [docs/windows-wsl-checklist.md](docs/windows-wsl-checklist.md)

위임에 쓸 모델은 `-m`, 환경변수 `OPENCODE_DELEGATE_MODEL`, 또는 `~/.config/opencode-delegate/model` 파일로 지정합니다. 자세한 사용법은 [SKILL.md](skills/opencode-delegate/SKILL.md)를 보세요.

## msgr 설치

[packages/msgr/README.md](packages/msgr/README.md)를 보세요.

## 보안 주의

- msgr로 들어오는 메시지는 다른 세션에 대한 사실상의 지시 경로입니다. 명령 자동 승인과 함께 쓰면 메시지 한 통으로 명령이 실행될 수 있습니다. 자세한 내용은 [msgr 보안 절](packages/msgr/README.md#보안)을 보세요.
- 위임 로그(프롬프트와 결과 전체)는 `~/.local/state/opencode-delegate/`에 소유자 전용으로 저장되고 7일 뒤 삭제됩니다.

## 라이선스

MIT
