#!/usr/bin/env bash
# 서버 실행 스크립트
set -e
cd "$(dirname "$0")/backend"
exec uvicorn app:app --reload --port 8000
