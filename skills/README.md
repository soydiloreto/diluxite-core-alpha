# Skills

Client-side skills that ride Diluxite's public MCP surface. They belong with
the agent, not in the engine: the engine needs nothing new for any of them,
which is the test of whether the MCP surface is actually complete.

| Skill | What it does |
|---|---|
| [`session-capture`](./session-capture/SKILL.md) | Writes what a session learned into the memory before it ends — decisions with their reason, and anything that turned out to be wrong. |

## Installing one

Copy the directory into the agent's skills folder. For Claude Code:

```bash
cp -r skills/session-capture ~/.claude/skills/
```

The agent needs Diluxite connected over MCP (Settings → Connect AI gives the
endpoint and a token).
