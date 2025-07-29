#!/usr/bin/env bash
set -e
curl -LsSf https://astral.sh/uv/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
uv tool update-shell || true
uv tool install claude-monitor
