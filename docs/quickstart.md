# Quickstart

Get Spacebot running locally in under 5 minutes.

## Prerequisites

- **Rust 1.85+** — `rustup update stable`
- **Bun** (optional, for the web UI) — `curl -fsSL https://bun.sh/install | bash`
- **An LLM API key** — Anthropic, OpenAI, or OpenRouter

## Build from source

```bash
git clone https://github.com/jamiepine/spacebot.git
cd spacebot

# Optional: build the web UI (React + Vite, embedded into the binary)
cd interface && bun install && cd ..

# Install the binary
cargo install --path .
```

The `build.rs` script automatically runs `bun run build` during compilation if `interface/node_modules` exists. Without it, the binary still works — you just get an empty UI on the web dashboard.

## Configure

Spacebot needs at least one LLM provider key. You can either set an environment variable or create a config file.

### Option A: Environment variable (fastest)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

This is enough. Spacebot will create a default `main` agent with sensible defaults and no messaging adapters. The web UI and HTTP API will be available on `http://localhost:19898`.

### Option B: Interactive onboarding

Just run `spacebot` with no config file and no API key env var set. It will walk you through provider selection, API key entry, agent naming, and optional Discord setup.

### Option C: Config file

Create `~/.spacebot/config.toml`:

```toml
[llm]
anthropic_key = "sk-ant-..."
# or: openrouter_key = "sk-or-..."
# or: openai_key = "sk-..."
# Keys also support env references: anthropic_key = "env:ANTHROPIC_API_KEY"

[[agents]]
id = "main"

# Optional: connect to Discord
[messaging.discord]
enabled = true
token = "env:DISCORD_BOT_TOKEN"

# Route Discord messages to the main agent
[[bindings]]
agent_id = "main"
channel = "discord"
```

See [config.md](config.md) for the full config reference.

## Run

```bash
# Background daemon (default)
spacebot

# Foreground with debug logging (recommended for first run / development)
spacebot start -f -d

# During development with cargo
cargo run -- start -f -d
```

On first launch, Spacebot automatically creates:

- `~/.spacebot/` — instance directory
- `~/.spacebot/agents/main/data/` — SQLite, LanceDB, and redb databases
- `~/.spacebot/agents/main/workspace/` — identity files and ingest directory

## Daemon management

```bash
spacebot status    # show pid and uptime
spacebot stop      # graceful shutdown
spacebot restart   # stop + start
spacebot restart -f -d  # restart in foreground with debug
```

Logs go to `~/.spacebot/agents/{id}/data/logs/` in daemon mode, or stderr in foreground mode.

## Identity files

Each agent has three optional markdown files in its workspace (`~/.spacebot/agents/{id}/workspace/`):

| File          | Purpose                                  |
| ------------- | ---------------------------------------- |
| `SOUL.md`     | Personality, values, communication style |
| `IDENTITY.md` | Name, nature, purpose                    |
| `USER.md`     | Info about the human the agent talks to  |

Template files are created on first run. Edit them to shape the agent's personality. Changes are hot-reloaded (no restart needed).

## Web UI

When the API is enabled (default), the web dashboard is served at:

```
http://localhost:19898
```

During development, the Vite dev server runs separately with API proxying:

```bash
cd interface && bun run dev
# UI at http://localhost:3000, proxies /api to http://localhost:19898
```

## Messaging platforms

| Platform | Status    | Setup guide                          |
| -------- | --------- | ------------------------------------ |
| Discord  | Supported | [discord-setup.md](discord-setup.md) |
| Slack    | Supported | [slack-setup.md](slack-setup.md)     |
| Webhook  | Planned   | —                                    |
| Telegram | Planned   | —                                    |

No messaging adapters are required. Without them, Spacebot is accessible via the web UI and HTTP API.

## CLI flags reference

```
spacebot [OPTIONS] [COMMAND]

Commands:
  start     Start the daemon [default]
  stop      Stop the running daemon
  restart   Restart the daemon
  status    Show daemon status

Global options:
  -c, --config <PATH>    Path to config file
  -d, --debug            Enable debug logging

Start/restart options:
  -f, --foreground       Run in foreground instead of daemonizing
```

## Next steps

- [Config reference](config.md) — full config.toml documentation
- [Model routing](routing.md) — per-process model selection and fallbacks
- [Memory system](memory.md) — how memories are stored and recalled
- [Agents](agents.md) — multi-agent setup
- [Cron jobs](cron.md) — scheduled tasks
