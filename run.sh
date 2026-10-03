#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js와 npm을 먼저 설치해 주세요.\n' >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/vite ]]; then
  printf '의존성을 설치합니다 (npm ci).\n'
  npm ci
fi

printf 'Qaxiom 로컬 개발 서버를 시작합니다. 종료: Ctrl+C\n'
exec npm run dev -- --host 127.0.0.1
