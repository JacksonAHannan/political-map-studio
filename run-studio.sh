#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
trap 'kill 0' EXIT
uv run uvicorn political_map_studio.app:app --host 127.0.0.1 --port 8000 &
npm run dev
