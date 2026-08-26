#!/usr/bin/env bash
#
# soif-app installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh | bash
#
# Piping a remote script into a shell means trusting whatever that URL serves.
# If you would rather not, the two-line form does exactly the same thing and
# lets you read it first:
#
#   curl -fsSLO https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh
#   less install.sh && bash install.sh
#
# What it does: clone into ./soif-app, install dependencies, run the setup
# wizard, and serve the dashboard. It writes nothing outside that directory
# except the clone itself, and asks for no credential — the local scans need
# none.
#
# Overridable: SOIF_DIR, SOIF_PORT, SOIF_REF (pin a tag, e.g. v1.0.0), SOIF_REPO.

set -euo pipefail

REPO="${SOIF_REPO:-https://github.com/Unchained-Labs/soif-app.git}"
DIR="${SOIF_DIR:-soif-app}"
PORT="${SOIF_PORT:-3000}"
# Pin a tag or branch, e.g. SOIF_REF=v1.0.0. Empty means the default branch.
REF="${SOIF_REF:-}"
REQUIRED_NODE_MAJOR=20

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  \033[2m·\033[0m %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n  \033[31m✗\033[0m %s\n\n' "$1" >&2; exit 1; }

printf '\n'
bold "  soif — water ledger for your AI usage"
printf '  \033[2m%s\033[0m\n\n' "──────────────────────────────────────────────"

# --- prerequisites ----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required but was not found."
command -v node >/dev/null 2>&1 || die "Node.js ${REQUIRED_NODE_MAJOR}+ is required but was not found. See https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node ${REQUIRED_NODE_MAJOR}+ is required; found $(node -v). Upgrade, or use nvm."
fi
ok "node $(node -v)"

# --- clone or reuse ---------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  info "Reusing the existing clone in ./$DIR"
  git -C "$DIR" pull --ff-only --quiet || info "Could not fast-forward; keeping the local state."
elif [ -e "$DIR" ]; then
  # Never write into a directory we did not create: it could be anything.
  die "./$DIR exists and is not a git clone. Move it, or set SOIF_DIR to another name."
else
  if [ -n "$REF" ]; then
    info "Cloning ${REF} into ./$DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
  else
    info "Cloning into ./$DIR"
    git clone --quiet --depth 1 "$REPO" "$DIR"
  fi
fi
cd "$DIR"
ok "source ready"

# --- dependencies -----------------------------------------------------------
info "Installing dependencies (this is the slow part)…"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
ok "dependencies installed"

# --- hand over to the wizard ------------------------------------------------
# Everything else — key generation, migrations, provider detection, the scan
# and the server — belongs to the wizard, so there is one implementation of it
# rather than a shell copy that drifts.
printf '\n'
exec npx --no-install tsx cli/soif-init.ts --yes --serve --port "$PORT"
