# Security

## Safe defaults

- The HTTP server listens on `127.0.0.1` unless explicitly configured otherwise.
- The Docker example publishes the MCP port only on VPS loopback.
- The repository contains no tunnel key, token, vault content, VPS address, or user-specific path.
- Write operations require the SHA-256 returned by the latest read, so a changed note is not silently overwritten.
- Path traversal, hidden paths, symlinked notes, deletion, and moving notes are blocked.
- New notes are created with exclusive file creation and never overwrite an existing file.

## Deployment rule

Do not expose port `3777` directly to the internet. Use the official OpenAI Secure MCP Tunnel or another authenticated private transport.

Store tunnel credentials outside the repository in a root-readable or service-user-readable environment file. Never commit `.env`, `runtime.env`, private keys, or a real tunnel profile.

## Reporting a vulnerability

Please open a GitHub security advisory instead of a public issue when the report contains an exploitable security problem.
