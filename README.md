# codex-claude

A Claude Code plugin that shows how much context and usage **Claude** and **Codex** are using, side by side, in a band just above the prompt.

It works in the Claude Code desktop app, the VS Code extension and the terminal.

## What it shows

One row sits above the prompt. Claude is on the left, Codex on the right, and a `+` button is in the middle:

```
✻  (1h) (4d) ▬▬▬▭▭          +          ▬▭▭▭▭ (4d) (2h)  ❂
```

- **Thinking icon** (`✻` Claude, `❂` Codex): gray while idle. It animates in the model's color while that model is working.
- **Usage rings**: one ring for the 5-hour window (thin line) and one for the weekly window (thick line).
  - The arc shows how much of the window is used.
  - The middle shows the time until the window resets (`3d`, `5h`, `42m`). With no reading, it shows `5h` or `1w`.
  - The middle text changes color as the window fills: gray, then grayish yellow from 50%, amber from 70%, red from 90%.
- **Context bar**: how full the model's context window is.

Press `+` to expand the details above the row:

- **Context**: the model, and tokens used out of the window.
- **Usage**: each window's percentage and its exact reset time.

On a wide enough band, Claude's details and Codex's sit in two columns.

Codex's numbers come from the Codex thread that the current Claude session started, so a new session starts at 0%.

The terminal draws no images, so there the rings and bars become text (`✻ 25%`).

### Pane

`/context-all` opens the same figures in a pane.

## Install

In Claude Code:

```
/plugin install codex-claude --marketplace MatLegat/codex-claude
```

### Requirements

- `python3`
- The [Codex CLI](https://github.com/openai/codex), logged in
- The Codex plugin for Claude Code (`openai-codex`). The Codex indicator reads its job records to tell when Codex is working.

Without Codex, the Claude side still works and the Codex side shows `—`.

## Settings

The plugin has one option, **Band layout** (`layout`). Set it in the plugin's settings, or in `settings.json`:

```json
{
  "pluginConfigs": {
    "codex-claude": { "options": { "layout": "models" } }
  }
}
```

| Value | Layout |
| --- | --- |
| `models` (default) | The single mirrored row described above. |
| `rings` | `Context` and `Usage` buttons, each followed by both models' marks. |
| `buttons` | One ring and one percentage button per model. |

## How it works

- **Claude's figures** come from Claude Code itself: the session's context and its rate limits.
- **Codex's figures** come from two scripts in [`codex-claude/scripts`](codex-claude/scripts):
  - `context-codex.py` reads the context of the session's Codex thread, and whether a Codex job is running, from `~/.codex/sessions` and the Codex plugin's job records.
  - `usage-codex.py` reads the 5-hour and weekly limits from `codex app-server`. If that fails, it falls back to the latest Codex session log.

Codex context refreshes every minute, and every 3 seconds while Codex is working. Codex usage refreshes every 5 minutes. Opening the details always fetches fresh numbers.

## Development

```
claude plugin test codex-claude
claude plugin validate codex-claude
```

Most look-and-feel choices, such as colors, ring and bar sizes, and line widths, are constants at the top of [`codex-claude/hooks/register.tsx`](codex-claude/hooks/register.tsx).
