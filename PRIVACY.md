# Privacy and Capabilities

Local LLM Helper is designed for local-first AI workflows in Obsidian. It does not include telemetry, analytics, advertising, or tracking code.

## Network Requests

The plugin makes network requests only when a user-configured feature needs them:

- Chat and text commands send selected text or prompts to the configured chat endpoint.
- RAG indexing sends note chunks to the configured embedding endpoint.
- RAG chat sends retrieved note context to the configured chat endpoint.
- Optional web and news search use the configured Tavily API, Brave Search API, or SearXNG instance.

Endpoints may be local, such as Ollama or LM Studio, or remote, such as OpenAI-compatible hosted APIs. Users control the server address and API keys in plugin settings.

## Vault Access

The plugin can enumerate and read Markdown files for indexing, semantic search, related-note suggestions, and workflow context. It creates or modifies notes only for explicit user actions, such as approved workflow or Vault Actions cards.

## Clipboard Access

The plugin may write generated text to the system clipboard when a user clicks a copy button. It does not read clipboard contents.

## Background Behavior

Automatic indexing is disabled by default. If enabled, it periodically re-indexes notes using the configured embedding server. Users can disable it at any time by setting the auto-index interval to `0`.

## Data Storage

RAG index data is stored locally in the plugin data folder inside the user's vault. API keys and settings are stored in Obsidian's plugin settings data.
