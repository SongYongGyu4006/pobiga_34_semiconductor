#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/backend"
exec uvicorn app:app --port 8000
