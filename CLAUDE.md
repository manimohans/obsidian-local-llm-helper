# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run dev      # Watch mode - rebuilds on file changes
npm run build    # Production build (type-check + bundle)
```

The build uses esbuild (`esbuild.config.mjs`) to bundle TypeScript into `main.js`. Entry point is `main.ts`.

## Architecture

This is an Obsidian plugin that integrates local LLM servers (Ollama, LM Studio, OpenAI-compatible) for text processing and RAG-based note search.

### Core Files

- **main.ts**: Plugin entry point. Contains:
  - `OLocalLLMPlugin` class with settings, command registration, ribbon menu, persona/prompt management
  - `LLMChatModal` for basic LLM chat
  - `EditPromptModal` for editing saved custom prompts
  - `processText()` for text transformation commands (summarize, make professional, etc.)
  - `processWebSearch()` / `processNewsSearch()` for web search (Tavily or Brave, configurable)
  - `tavilySearch()` helper handles Tavily API calls

- **src/personas.ts**: Persona system:
  - `Persona` type: `{ displayName, systemPrompt }`
  - `DEFAULT_PERSONAS` — 12 built-in personas with system prompts
  - `buildPersonasDict()` — merges defaults with user-saved overrides
  - `modifyPrompt()` — prepends persona system prompt to user prompt

- **src/customPrompts.ts**: Saved prompts system:
  - `CustomPrompt` interface: `{ id, title, prompt, systemPrompt?, createdAt, updatedAt }`
  - `SelectPromptModal` extends `FuzzySuggestModal` for fuzzy-searchable prompt picker
  - `generatePromptId()` — creates safe command IDs from titles

- **src/reasoningExtractor.ts**: Reasoning block removal:
  - Strips `<think>`, `<reasoning>`, `<thought>` blocks from LLM output
  - `extractActualResponse()` — regex-strips marker pairs
  - `parseReasoningMarkers()` — parses user-configured JSON markers

- **src/rag.ts**: `RAGManager` handles:
  - Document indexing with chunking (1000 chars)
  - Vector embeddings via Ollama or OpenAI providers
  - Persistent storage in `embeddings.json` (separate from plugin `data.json`)
  - Similarity search using LangChain's `MemoryVectorStore`
  - Automatic settings comparison to detect when re-indexing is needed

### Feature Modules (src/)

| File | Purpose |
|------|---------|
| `personas.ts` | Persona type, defaults, `buildPersonasDict()`, `modifyPrompt()` |
| `customPrompts.ts` | `CustomPrompt` interface, `SelectPromptModal` fuzzy picker |
| `reasoningExtractor.ts` | Strips reasoning/thinking blocks from LLM output |
| `ragChatModal.ts` | Chat interface with RAG - queries indexed notes |
| `promptPickerModal.ts` | Quick prompt picker for "Edit with prompt..." command |
| `autoTagger.ts` | Generates hashtags for selected text |
| `backlinkGenerator.ts` | Suggests backlinks based on semantic similarity |
| `ollamaEmbeddings.ts` | Ollama `/api/embeddings` integration |
| `openAIEmbeddings.ts` | OpenAI-compatible embeddings |
| `updateNoticeModal.ts` | Shows changelog on version updates |

### Data Flow

1. **Text Commands**: Selected text → `modifyPrompt()` (adds persona via `personasDict`) → LLM API (`/v1/chat/completions`) → Optional reasoning extraction → Replace/append selection
2. **RAG Chat**: Query → `RAGManager.getRAGResponse()` → Similarity search → LangChain retrieval chain → Optional reasoning extraction → Response with sources
3. **Embeddings**: Notes → `splitIntoChunks()` → Provider's `embedDocuments()` → `MemoryVectorStore` → Persist to `embeddings.json`
4. **Custom Prompts**: Saved prompts register as commands on load → User selects via palette or fuzzy picker → `processText()` runs the prompt

### Settings Structure

`OLocalLLMSettings` interface in main.ts defines all configurable options:
- `providerType`: 'ollama' | 'openai'
- `serverAddress`: Full URL including port (e.g., `http://localhost:11434`)
- `llmModel`: Model name for chat completions
- `embeddingModelName`: Model for embeddings (e.g., `mxbai-embed-large`)
- `stream`: Enable streaming responses
- `personas`: Key from `personasDict` for prompt modification
- `savedPersonas`: User-created/modified personas (merged with defaults)
- `customPrompts`: Array of saved `CustomPrompt` objects
- `extractReasoningResponses`: Strip reasoning blocks from output (default: false)
- `reasoningMarkers`: JSON array of `{start, end}` marker pairs
- `searchProvider`: 'brave' | 'tavily' (default: 'tavily')
- `tavilyApiKey`: API key for Tavily search
- `braveSearchApiKey`: API key for Brave search

## Release Process

### 1. Update version in these files:
- `manifest.json` - change the `version` field
- `src/updateNoticeModal.ts` - add changelog text for the new version
- `updatetags.sh` - update the version in the git tag command

### 2. Build the plugin:
```bash
npm run build
```

### 3. Commit the changes:
```bash
git add manifest.json src/updateNoticeModal.ts updatetags.sh README.md package-lock.json
git commit -m "chore: prepare release vX.X.X"
```

### 4. Push to remote (critical - must be done before tagging):
```bash
git push origin main
```

### 5. Create and push the tag:
```bash
./updatetags.sh
```

### 6. Publish the release:
Go to GitHub and manually publish the draft release.

### What happens automatically:
GitHub Actions (`.github/workflows/release.yml`) triggers when a tag is pushed and:
- Builds the plugin
- Creates a **draft release** with `main.js`, `manifest.json`, and `styles.css`

**Important:** Always push commits to `main` before running `updatetags.sh` — GitHub Actions needs the commits available on the remote to build correctly.

## Key Patterns

- Uses Obsidian's `requestUrl()` for HTTP requests (works around CORS)
- Streaming responses use native `fetch()` with reader for chunked output
- Conversation history limited to 3 entries (`maxConvHistory`)
- Kill switch (`isKillSwitchActive`) stops in-progress generation
- Status bar shows current state ("Ready" / "Generating response...")

## MCP Integration Notes

Evaluated MCP (Model Context Protocol) integration and decided against it. Key reasons:
- Plugin uses a **direct-action** pattern (user picks command → LLM processes) — no tool-calling or function-calling exists in the codebase
- MCP requires the LLM to autonomously decide which tools to invoke, which needs reliable function-calling support
- Local LLMs (Ollama, LM Studio) have poor/inconsistent tool-calling — building MCP infra would only work well with cloud models
- Adding concrete integrations (like Tavily/Brave) directly is simpler and more reliable than the MCP indirection layer
- Revisit if: local LLM tool-calling matures, or an agentic chat mode is added where the LLM orchestrates multiple tools
