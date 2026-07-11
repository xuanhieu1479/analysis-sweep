# Analysis Sweep

A SillyTavern extension for chat cleanup and lorebook integration.

## Features

### Message Scanning & Deletion

- **Pattern Scan**: Scan chat messages for configurable patterns (e.g., self-reflection questions). Messages matching above a threshold percentage are flagged for review.
- **Mark for Deletion**: Each message has a trash icon button to manually mark it for deletion.
- **Bulk Delete**: Review and delete multiple messages at once from scan results.

### Compact (OOC Stripping)

- **Compact Scan**: Find and strip OOC context blocks from messages using a configurable pattern.
- **Pattern Template**: Use `{{content}}` as a placeholder to match any text within your OOC wrapper (e.g., `[OOC: {{content}}]`).
- **Preview Before Apply**: Review before/after diffs for each message before applying changes.

### Floating Shortcut Buttons

Three buttons anchored to the left side of the chat area:
- **Broom** - Open pattern scan
- **Compress** - Open compact scan  
- **Rotate** - Reload current chat

### Slash Commands

| Command | Description |
|---------|-------------|
| `/clear N` | Delete messages from index N to last-1, preserving the final message |
| `/mark N` | Mark messages from index N to end for deletion |
| `/compact` | Scan messages and open compact preview |

### Lorebook Management Integration

- **Auto-reload World Info**: Automatically reloads SillyTavern's world info cache when the [Lorebook Management app](https://github.com/xuanhieu1479/SillyTavern-Lorebook-Management) saves changes (via SSE).
- **Sync Compact Pattern**: Fetches the compact pattern from the Lorebook Management app settings.
- **Clear Copied Flags**: Clears "copied" entry flags in the app after compacting chat.

## Settings

Access extension settings in SillyTavern's Extensions panel under "Analysis Sweep":

- **Pattern**: Lines to search for in messages (one per row)
- **Match Threshold**: Percentage of pattern lines required to flag a message
- **Fuzzy Match**: Case-insensitive substring matching
- **Compact Pattern**: Template for OOC blocks to strip

## Installation

1. Open SillyTavern's Extensions panel
2. Install from URL: `https://github.com/xuanhieu1479/analysis-sweep`
