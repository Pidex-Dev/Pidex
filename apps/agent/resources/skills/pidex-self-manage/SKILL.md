---
name: pidex-self-manage
description: Guide for managing Pidex settings, profiles, skills, hooks, MCP servers, and plugins through natural language using pidex_config, pidex_skill, pidex_hook, pidex_mcp, and pidex_plugin.
---

# Pidex Self-Management Guide

When the user asks to change Pidex settings, switch profiles, install/create/toggle skills, add/debug hooks, configure MCP servers, or install/toggle plugins, discover the `pidex_*` deferred tools via `ToolSearch` and use them directly.

## 1. Settings & Profiles (`pidex_config`)

- Actions: `read`, `set`, `list_profiles`, `select_profile`.
- Always call `read` before modifying unfamiliar keys so you know the current values and layer origins (`user`, `profile`, `project`).
- Default scope:
  - Global/UI/model preferences (`desktop.*`, `features.*`, `model`, `model_reasoning_effort`, `personality`, `approval_policy`, `sandbox_mode`, `shell_security_level`, `profile`) belong in `scope: "user"`.
  - Project-specific instructions (`custom_instructions`, `system_prompt`, `append_system_prompt`) can be written to `scope: "project"` when requested for the current workspace.
- Never write plaintext secrets (`apiKey`, `oauthToken`, `accessToken`, `password`, etc.) into `config.json`.
- Setting a `keyPath` value to `null` deletes that key.

## 2. Skills (`pidex_skill`)

- Actions: `list`, `read`, `create`, `install`, `set_enabled`, `remove`.
- Default scope: `"project"` (writes to `<workspace>/.pidex/skills/<name>/SKILL.md`) unless the user explicitly asks for global/user scope (`"user"`).
- `SKILL.md` must have valid YAML frontmatter with `name` (1-64 chars `[a-z0-9][a-z0-9_-]*`) and `description`, plus a non-empty markdown body.
- `install` supports `{ kind: "local", path }` and `{ kind: "git", url, ref?, subpath? }` (HTTPS Git URLs only).
- Newly created or installed skills return their `SKILL.md` content immediately and can be followed right away in the same turn.

## 3. Hooks (`pidex_hook`)

- Actions: `list`, `upsert`, `remove`, `set_enabled`, `list_runs`.
- Default scope: `"project"` (writes to `<workspace>/.pidex/hooks.json`) unless the user explicitly asks for global/user scope (`"user"`).
- Supported `event` values:
  - `session_start`, `session_resume`, `user_prompt_submit`, `pre_tool_use`, `permission_request`, `post_tool_use`, `post_tool_error`, `pre_compact`, `stop`, `subagent_start`, `subagent_stop`.
- Hook fields: `{ id, event, command, matcher?, timeoutMs? (1..60000), statusMessage? }`.
- Hook execution contract:
  - Commands run in PowerShell on Windows and receive JSON evidence via stdin.
  - For `pre_tool_use` / `permission_request`, stdout JSON may return `{ "decision": "continue" | "ask" | "deny", "reason"?: "...", "narrowedInput"?: {...} }`.
  - Use `list_runs` to inspect recent hook failures and diagnose errors.

## 4. MCP Servers (`pidex_mcp`)

- Actions: `list`, `status`, `save`, `remove`, `set_enabled`, `reload`.
- Default scope: `"local"` (project-scoped) unless the user asks for `"user"` (global).
- Supports `stdio` (`command`, `args`, `cwd`, `env`, `envFromHost`) and `http` (`url`, `auth`, `headers`, `headerFromEnv`, `bearerTokenEnvVar`).
- `save`, `remove`, and `set_enabled` automatically reload connections. New or updated MCP tools become available on the next user turn.

## 5. Plugins (`pidex_plugin`)

- Actions: `list`, `details`, `install`, `uninstall`, `set_enabled`.
- Plugins are always user-scoped.
- Enabling a plugin does not grant application-level permissions (e.g. Computer Use still requires normal authorization).
- Newly installed/enabled plugin tools become available on the next user turn.
