# Privacy and Capabilities

Local LLM Helper is designed for local-first AI workflows in Obsidian. It does not include telemetry, analytics, advertising, or tracking code.

## Network Requests

The plugin makes network requests only when a user-configured feature needs them:

- Chat and text commands send selected text or prompts to the configured chat endpoint.
- RAG indexing sends note chunks to the configured embedding endpoint.
- Semantic retrieval for RAG chat and Related Notes sends the user's question, active-note text, or selected text to the configured embedding endpoint. RAG chat then sends the prompt and retrieved note context to the configured chat endpoint.
- Manual and automatic Vault Radar runs send bounded excerpts from recently changed Markdown notes to the configured chat endpoint so the model can generate cited insight cards. When feedback exists, Radar also sends the kind and title of up to six cards marked Helpful and six cards marked Wrong as quality guidance.
- Optional web and news search use the configured Tavily API, Brave Search API, or SearXNG instance.

Endpoints may be local, such as Ollama or LM Studio, or remote, such as OpenAI-compatible hosted APIs. Users control the server address and API keys in plugin settings.

## Vault Access

The plugin can enumerate and read Markdown files for indexing, semantic search, related-note suggestions, workflow context, and Vault Radar. Vault Radar reads only a bounded set of recently changed notes per run and does not edit notes. The plugin creates or modifies notes only for explicit user actions, such as approved workflow or Vault Actions cards.

## Clipboard Access

The plugin may write generated text to the system clipboard when a user clicks a copy button. It does not read clipboard contents.

## Background Behavior

- Automatic indexing is disabled by default. If enabled, it periodically re-indexes notes using the configured embedding server. Users can disable it at any time by setting the auto-index interval to `0`.
- Automatic Vault Radar runs are also disabled by default. If enabled, Radar schedules a daily run while Obsidian and the plugin are active; a failed run may retry later. Each run sends bounded excerpts from changed Markdown notes and, when available, the limited prior-card feedback metadata described above to the configured chat endpoint. Users can turn automatic runs off at any time in Settings → Vault Radar and can always run Radar manually instead.

## Data Storage

RAG index data is stored locally in the plugin data folder inside the user's vault. Vault Radar stores its scan state locally in `vault-radar-state.json` in the plugin folder, including source note paths and metadata, generated insight cards, feedback, snoozes, and dismissals. API keys and settings are stored in Obsidian's plugin settings data.
