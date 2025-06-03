# Obsidian Local LLM Helper Plugin

## Overview
A privacy-focused Obsidian plugin that integrates local LLM servers (Ollama, LM Studio) to enhance note-taking capabilities without sending data to external services.

## Key Features
- **Local LLM Integration**: Works with OpenAI-compatible servers for offline functionality
- **Text Processing Commands**: Summarization, tone adjustment, action item generation, custom prompts
- **RAG Chat Interface**: Interactive chat with indexed notes using embeddings
- **Backlink Generation**: Automatically generate relevant backlinks between notes
- **Auto-Tagging**: Generate contextual tags for notes
- **Web/News Search Integration**: Search capabilities with Brave API support

## Recent Refactoring (v2.1.2)
The codebase underwent significant refactoring to improve organization:
- All feature modules moved to `src/` directory
- Better separation of concerns with dedicated files for each feature
- Added support for both Ollama and OpenAI embeddings

## Main Components
- **main.ts**: Core plugin class, settings management, command registration
- **src/rag.ts**: RAGManager for document indexing and retrieval
- **src/ragChatModal.ts**: Chat interface with RAG capabilities
- **src/autoTagger.ts**: Automatic tag generation for notes
- **src/backlinkGenerator.ts**: Intelligent backlink suggestions
- **src/ollamaEmbeddings.ts**: Ollama embedding provider
- **src/openAIEmbeddings.ts**: OpenAI-compatible embedding provider
- **src/updateNoticeModal.ts**: Version update notifications

## Technical Details
- Supports multiple personas for tailored AI responses
- Configurable streaming output and response formatting
- Maintains conversation history (up to 3 prompts)
- Uses vector embeddings for semantic search in notes
- Temperature and max token controls for response generation

## Release Process

### Prerequisites
1. Ensure all changes are tested locally
2. Check for security vulnerabilities: `npm audit`
3. Fix any vulnerabilities: `npm audit fix`

### Release Steps
1. **Decide Version Number**: Follow semantic versioning (major.minor.patch)
   - Major: Breaking changes
   - Minor: New features (e.g., 2.1.2 → 2.2.0)
   - Patch: Bug fixes only

2. **Update Files** (in this order):
   - `manifest.json`: Update version number
   - `src/updateNoticeModal.ts`: Update changelog text with new features
   - `updatetags.sh`: Update version in git tag command
   - `README.md`: Add release notes for new version

3. **Build**: Run `npm run build` to generate production files

4. **Commit Changes**:
   ```bash
   git add manifest.json src/updateNoticeModal.ts updatetags.sh README.md package-lock.json
   git commit -m "chore: prepare release vX.X.X"
   ```

5. **Create Tag and Release**:
   ```bash
   ./updatetags.sh  # This creates tag and pushes to trigger GitHub Actions
   ```

### GitHub Actions
The `.github/workflows/release.yml` automatically:
- Builds the plugin when a tag is pushed
- Creates a draft release with `main.js`, `manifest.json`, and `styles.css`
- You need to manually publish the draft release on GitHub

### Important Notes
- The `version-bump.mjs` script is for `npm version` command (not used in current process)
- `versions.json` tracks Obsidian compatibility but isn't updated in releases
- Always ensure `manifest.json` version matches the git tag
- The build process generates `main.js` from TypeScript sources