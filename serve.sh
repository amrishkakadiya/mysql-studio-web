#!/bin/sh
# MySQL Studio Web — one-command install + serve (first-timers and daily use)
set -e

cd "$(dirname "$0")"

APP_NAME="MySQL Studio Web"
LOCAL_HOST="mysql-studio-web.local"
DEFAULT_PORT=3000

usage() {
  cat <<EOF
Usage: sh serve.sh [--setup-hosts] [--help]

  Starts ${APP_NAME}: installs npm deps if needed, ensures data dirs, then serves.

  --setup-hosts   Add 127.0.0.1 ${LOCAL_HOST} to /etc/hosts (needs sudo once)
  --help          Show this help

Optional .env (copy from .env.example):
  PORT=3000
  HOST=0.0.0.0
EOF
}

SETUP_HOSTS=0
for arg in "$@"; do
  case "$arg" in
    --setup-hosts) SETUP_HOSTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ensure_hosts() {
  if grep -qE "[[:space:]]${LOCAL_HOST}([[:space:]]|$)" /etc/hosts 2>/dev/null; then
    echo "Hosts: ${LOCAL_HOST} already present in /etc/hosts"
    return 0
  fi
  echo "Hosts: adding 127.0.0.1 ${LOCAL_HOST} to /etc/hosts (sudo may prompt)..."
  if ! command -v sudo >/dev/null 2>&1; then
    echo "  sudo not available. Add manually:"
    echo "    127.0.0.1 ${LOCAL_HOST}"
    return 1
  fi
  if echo "127.0.0.1 ${LOCAL_HOST}" | sudo tee -a /etc/hosts >/dev/null; then
    echo "Hosts: added ${LOCAL_HOST}"
    return 0
  fi
  echo "Hosts: could not update /etc/hosts. Add manually:"
  echo "    127.0.0.1 ${LOCAL_HOST}"
  return 1
}

if [ "$SETUP_HOSTS" -eq 1 ]; then
  ensure_hosts || true
elif ! grep -qE "[[:space:]]${LOCAL_HOST}([[:space:]]|$)" /etc/hosts 2>/dev/null; then
  echo "Tip: run  sh serve.sh --setup-hosts  once to use http://${LOCAL_HOST}"
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)..."
  npm install
fi

echo "Building Tailwind CSS..."
npm run build:css --silent

mkdir -p data/config data/exports data/scripts
chmod 755 data data/exports 2>/dev/null || true
chmod 700 data/config data/scripts 2>/dev/null || true

# Banner port: shell PORT > .env PORT > default (Node loads .env the same way)
BANNER_PORT="$DEFAULT_PORT"
if [ -f .env ]; then
  parsed=$(grep -E '^[[:space:]]*PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'")
  if printf '%s' "$parsed" | grep -Eq '^[0-9]+$'; then
    BANNER_PORT="$parsed"
  fi
fi
if printf '%s' "${PORT-}" | grep -Eq '^[0-9]+$'; then
  BANNER_PORT="$PORT"
fi

echo "Starting ${APP_NAME}..."
echo "  http://localhost:${BANNER_PORT}"
echo "  http://${LOCAL_HOST}:${BANNER_PORT}"
exec node server.js
