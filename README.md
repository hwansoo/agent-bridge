# agent-bridge

코딩 에이전트(Claude Code, OpenCode, Codex, agy)를 서로 연결해 쓰기 위한 도구 모음입니다.

| 구성 요소 | 하는 일 | 상태 |
|---|---|---|
| [`skills/opencode-delegate`](skills/opencode-delegate) | Claude Code 같은 비싼 모델로 설계한 뒤, 구현·리서치를 OpenCode의 저렴한 모델에 위임하는 스킬 | macOS에서 검증. Windows(Git Bash)/WSL은 미검증 |
| [`packages/msgr`](packages/msgr) | 실행 중인 에이전트 세션끼리 메시지를 주고받는 MCP 서버 + CLI | macOS에서 4개 도구 모두 검증. Windows/Linux 미검증 |

두 구성 요소는 서로 독립적입니다. 필요한 것만 쓰면 됩니다.

## 위임 스킬 설치

```sh
mkdir -p ~/.claude/skills
cp -r skills/opencode-delegate ~/.claude/skills/
```

위임에 쓸 모델은 `-m`, 환경변수 `OPENCODE_DELEGATE_MODEL`, 또는 `~/.config/opencode-delegate/model` 파일로 지정합니다. 자세한 사용법은 [SKILL.md](skills/opencode-delegate/SKILL.md)를 보세요.

## msgr 설치

[packages/msgr/README.md](packages/msgr/README.md)를 보세요.

## 라이선스

MIT
