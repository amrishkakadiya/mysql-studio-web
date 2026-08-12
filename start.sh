#!/bin/sh
# Alias: prefer serve.sh (installs deps if needed, then starts the app).
exec "$(dirname "$0")/serve.sh" "$@"
