# Install

## One line

```bash
curl -fsSL https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh | bash
```

Clones into `./soif-app`, installs dependencies, runs the setup wizard, and leaves the dashboard
running on <http://localhost:3000>.

!!! warning "Piping a script into a shell"
    That one-liner means trusting whatever the URL serves at the moment you run it. That is a
    reasonable thing to object to. The two-line form does exactly the same work and lets you read
    it first:

    ```bash
    curl -fsSLO https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh
    less install.sh && bash install.sh
    ```

    The script writes nothing outside the directory it creates, and asks for no credential.

### Pinning and overrides

```bash
SOIF_REF=v1.0.0 bash install.sh    # pin a tag instead of the default branch
SOIF_PORT=4000   bash install.sh   # serve somewhere else
SOIF_DIR=ledger  bash install.sh   # clone into ./ledger
```

## From a clone

```bash
git clone https://github.com/Unchained-Labs/soif-app
cd soif-app
npm run setup        # install, set up, scan, build, serve
```

Variants:

```bash
npm run setup:only              # set up and scan, but do not serve
npx soif-init --dry-run         # show the plan, change nothing
npx soif-init --serve --port 4000
npx soif-init --yes --no-open   # scripted installs
```

## What the wizard does

```
[1/5] Looking for AI tools with readable usage
  ✓ Claude Code (local scan) (255 files)
  ✓ Codex CLI (local scan) (31 files)
[2/5] Configuration            ✓ Created .env with a new encryption key.
[3/5] Preparing the database   ✓ Schema is up to date.
[4/5] Scanning                 ✓ Scanned 541 MB, stored 21,836 new records.
[5/5] What that cost

  546 L of freshwater, across 21,836 calls.
  range 45.4 L – 6,308 L · mid scenario
```

It never overwrites an existing `SOIF_ENCRYPTION_KEY`: losing that key makes every stored
credential undecryptable, and silently rotating it during a setup command would be a genuinely
destructive surprise.

## Requirements

- **Node 20+**. The installer checks and refuses rather than failing halfway.
- **No database server.** SQLite is the default and needs nothing installed.
- Postgres is optional, for a shared deployment — see [Architecture](architecture.md).

## Self-hosting with Docker

```bash
cp .env.example .env      # set SOIF_ENCRYPTION_KEY
docker compose up
```

Brings up Postgres and the dashboard, with the transcript directory mounted **read-only** and the
app running as a non-root user. Self-hosting is not an afterthought here: you are being asked for
an admin-scoped API key, so running the whole thing on your own infrastructure has to be a
first-class path.

## Scanning later

```bash
npx soif-scan                   # incremental: only new bytes
npx soif-scan --full            # ignore cursors, re-read everything
npx soif-scan --no-embodied     # operational water only
npx soif-scan --json            # machine-readable
npx soif-scan --import x.csv    # any provider's export
```

Re-scanning is safe and cheap. Per-file byte cursors skip unchanged transcripts, and a unique
`(source_id, dedupe_key)` absorbs anything that does get re-read — a full re-read of 21,659 rows
inserted exactly the one row that was genuinely new.
