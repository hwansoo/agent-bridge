---
name: opencode-delegate
description: 구현·리서치·테스트 작성 같은 작업을 OpenCode(더 싼 모델)에 위임하고 결과를 검토한다. 사용자가 "OpenCode에 시켜", "싼 모델로 구현해", "위임해" 라고 하거나, 설계를 마친 뒤 범위가 명확한 구현·조사 작업을 넘길 때 사용.
---

# OpenCode 위임

역할 분담: **당신(이 세션)은 설계·판단·검토**, **OpenCode는 범위가 명확한 구현·조사**를 맡는다.
도구는 이 폴더의 `delegate.sh` 하나다(bash, grep, opencode만 필요).

```bash
bash ~/.claude/skills/opencode-delegate/delegate.sh <plan|build> [-m 모델] [-s 세션] [-w 워크트리] [-y] -- "지시문"
```

## 위임해도 되는 것 / 안 되는 것
- 위임: 범위와 완료 기준이 분명한 구현, 코드베이스 조사·요약, 테스트 작성, 기계적 리팩터링, 문서 초안.
- 위임하지 말 것: 설계 결정, 요구가 모호한 일, 보안·권한·비밀 정보가 얽힌 일, 직접 하는 게 더 빠른 한두 줄 수정.
- 비밀(토큰, 키, 개인정보)을 지시문이나 첨부에 넣지 않는다.

## 절차
1. **모드 선택**: 읽기만 하면 `plan`(파일 수정 불가), 파일을 고쳐야 하면 `build`.
2. **지시문은 자급자족하게** 쓴다. OpenCode는 이 대화를 모른다. 포함할 것:
   - 목표 한 줄, 관련 파일 경로, 따라야 할 기존 규칙/스타일
   - 건드리면 안 되는 것, 완료 기준(예: "`npm test`가 통과")
   - 마지막에 "변경한 파일과 실행한 테스트를 요약해 줘"
3. **실행**하고 출력의 `EXIT`, `SESSION`, 최종 응답을 읽는다. 전체 이벤트는 `LOG` 파일에 있다.
4. **검토는 직접 한다**: `build`였다면 `git status`와 `git diff`를 읽고 테스트를 실행한다. OpenCode의 "완료했다"는 말만 믿지 않는다.
5. 고칠 게 있으면 `-s <SESSION>`으로 **같은 세션에 구체적 피드백**을 준다. 두 번 시도해도 안 되면 직접 하거나 사용자에게 알린다.
6. 마지막에 어떤 모델이 무엇을 했고 검증 결과가 어땠는지 사용자에게 짧게 보고한다.

오래 걸릴 일은 Bash를 백그라운드로 실행하고(`run_in_background`) 끝나면 확인한다.

## 안전 규칙 (아래 동작은 임시 저장소에서 직접 확인함)
- `build`는 **-y 없이도 프로젝트 안의 파일을 즉시 수정한다**(승인 요청이 뜨지 않음). 그러니 작업 트리에 미커밋 변경이 있거나 범위가 크면 반드시 `-w <이름>`으로 격리한다.
- `-w`를 쓰면 OpenCode가 저장소 바깥(`~/.local/share/opencode/worktree/<프로젝트>/<이름>`)에 분리된 워크트리(detached HEAD)를 만들고 거기서만 수정한다. 메인 트리는 그대로다.
  - 결과 확인: `git worktree list`로 경로를 찾아 `git -C <경로> status` / `git -C <경로> diff`
  - 가져오기: 검토 후 `git -C <경로> diff | git apply`(메인 트리에서)
  - 정리: `git worktree remove --force <경로>` (쌓이므로 끝나면 지운다)
- `-y`(`--auto`)는 OpenCode가 명령 실행 같은 승인이 필요한 일을 스스로 승인하게 한다. **워크트리나 깨끗한 브랜치에서만** 쓰고, 꼭 필요할 때만 쓴다(이번 확인에서는 단순 파일 생성에 필요하지 않았다).
- 비밀(토큰, 키, 개인정보)은 지시문이나 첨부에 넣지 않는다.

## 모델 설정 (나중에 바꿀 수 있음)
우선순위: `-m` 인자 > 환경변수 `OPENCODE_DELEGATE_MODEL` > 파일 `~/.config/opencode-delegate/model`(한 줄) > OpenCode 기본 모델.
- 사용 가능한 이름은 터미널에서 `opencode models`로 본다(형식 `provider/model`).
- 사내 모델 이름을 알게 되면: `mkdir -p ~/.config/opencode-delegate && echo "<provider/model>" > ~/.config/opencode-delegate/model`
- 아무 설정이 없으면 OpenCode에 설정된 기본 모델을 쓴다.

## 문제 해결
- `Free usage limit reached` → 무료 모델 한도. 다른 모델(`-m`)을 쓰거나 provider를 연결한다.
- `opencode: command not found` → OpenCode가 PATH에 없다. Windows는 Git Bash에서, WSL은 WSL 안에서 `which opencode`를 확인한다.
- 빈 응답 → `LOG`와 `.err` 파일(같은 폴더)을 읽어 원인을 본다.
- 로그 위치: `~/.local/state/opencode-delegate/`(소유자 전용, 7일 지난 로그는 자동 삭제). 위치는 `OPENCODE_DELEGATE_LOG_DIR`, 보관 기간은 `OPENCODE_DELEGATE_LOG_DAYS`로 바꿀 수 있다. 로그에는 프롬프트와 결과가 모두 들어 있으므로 공유하지 않는다.
