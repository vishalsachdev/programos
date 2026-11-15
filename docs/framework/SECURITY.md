# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral runtime** - The container process is short-lived per invocation (`--rm`). Process stdin closes immediately after the initial JSON input. When an agent result arrives, `GroupQueue.closeStdin()` writes the IPC `_close` sentinel to signal wind-down; timeouts provide a fallback. Delivery validation and terminal outcomes follow the agent run, rather than closing its stdin
- **Persistent Claude state** - The host re-mounts each group's `.claude/` directory and passes the last saved session ID into later containers, so Claude conversation history and compaction artifacts usually survive container shutdown

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Container shutdown or timeout does **not** by itself erase that session state; later containers normally resume it through the stored session ID
- If resume data is stale or corrupt, the host clears that session ID and the next run starts a fresh Claude session for the same group/thread
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (In-Repo Credential Proxy)

The host's long-lived Anthropic API key and OAuth token are not passed into containers. On startup, NanoClaw launches its in-repo credential proxy (`startCredentialProxy()` in `src/index.ts`) and routes container Anthropic traffic through that local gateway.

**How it works:**
1. The host reads `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from the host `.env`
2. When NanoClaw spawns a container, it points Anthropic HTTP traffic at the local proxy instead of exposing those credentials directly
3. If an OAuth token is configured, the proxy replaces the placeholder Authorization header for the Claude CLI exchange and auth probes. The CLI receives a temporary API key and uses it for subsequent requests; that temporary key is present inside the container. Otherwise the proxy injects the host `x-api-key` on outbound API requests
4. `ANTHROPIC_API_KEY` remains available on the host for direct Messages API callers such as the behaviour sensor, because OAuth tokens cannot call that API
5. The host `.env` is excluded from mounts, and the spawner supplies placeholder Anthropic credentials. This isolates the long-lived Anthropic secrets; it is not a general guarantee that writable repository mounts contain no credentials

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                            │
│  Incoming Messages (potentially malicious)                       │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                       │
│  • Message routing                                               │
│  • IPC authorization                                             │
│  • Mount validation (external allowlist)                         │
│  • Container lifecycle                                           │
│  • Local credential proxy (injects OAuth/API key)                │
│  • Behaviour sensor uses host API key directly                   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, host .env excluded
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                    │
│  • Agent execution                                               │
│  • Bash commands (sandboxed)                                     │
│  • File operations (limited to mounts)                           │
│  • Anthropic API calls routed through local credential proxy     │
│  • Placeholder auth; temporary OAuth-exchange key possible       │
└──────────────────────────────────────────────────────────────────┘
```

