# Security

You are being asked for admin-scoped API keys. That is the primary risk in this codebase — larger
than anything the estimates can get wrong.

## Credentials

**Envelope encryption.** A per-source AES-256-GCM data key encrypts the credential; that data key
is itself wrapped by a master key from `SOIF_ENCRYPTION_KEY`, which never enters the database.

- Per-source data keys mean compromising one row does not decrypt the others.
- Rotating the master key rewraps a small key rather than re-encrypting every secret.
- The sealed form carries a key id, so rotation can be staged: new writes seal under the new key
  while old rows still decrypt under the old one.
- A wrong key is refused by id rather than returning garbage.
- Tampering is detected — GCM authenticates, and a truncated or edited blob fails to open.

## Never logged, never returned

- `listSources()` **strips** the sealed blob rather than merely not displaying it, so it is never
  sitting in an object some route might serialise.
- Postgres URLs are redacted before they can reach an error message — a connection failure will
  otherwise happily print the password.
- API error messages carry the status code and nothing from the response body, which can echo
  request context.
- There is no column a plaintext key could be written to, and a test asserts that.

## Scope

Read-only. Only the usage and cost report endpoints are ever called.

## What this deliberately does not do

The macOS tooling in this space reads the Keychain (`"Claude Code-credentials"`) and scrapes
browser cookies. This does neither. Both are macOS-only and a poor fit for something already
holding an org admin key — notably CodexBar will not touch Claude's credential store for
multi-account either, delegating to an external binary instead.

Account attribution here comes from the non-secret `oauthAccount` label in `.claude.json`, and the
equivalent identity fields in `~/.codex/auth.json`. **Nothing reads a token.**

## Nothing leaves the machine

- Self-hosted mode makes **no outbound calls to any soif-operated service.** There is none.
- Fonts are self-hosted via `next/font`, so a running deployment makes no outbound request at all.
- No telemetry on usage content. This ingests token *counts*. Prompts are never read, stored or
  transmitted — the scanner does not even parse the `content` field.
- The Docker image runs as a non-root user, with the transcript directory mounted read-only.

## Rate limiting

The Anthropic usage API's documented guidance is at most one poll per minute, and data lands within
about five minutes. The sync path respects that; the local scans touch no network at all.
