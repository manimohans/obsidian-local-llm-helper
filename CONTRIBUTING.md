# Contributing to Local LLM Helper

Thanks for helping improve Local LLM Helper. This plugin is built for Obsidian users who want private, local-first AI workflows, so contributions should keep user control and vault safety at the center.

## Development Setup

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Run a production build:

```bash
npm run build
```

4. For local Obsidian testing, copy or symlink the repository into:

```text
<vault>/.obsidian/plugins/obsidian-local-llm-helper
```

Then reload Obsidian or disable and re-enable the plugin.

## Before Opening a Pull Request

- Run `npm run build`.
- Keep changes focused and avoid unrelated formatting churn.
- Do not add telemetry, analytics, or background network behavior.
- Keep vault writes behind explicit user approval.
- Use Obsidian APIs such as `requestUrl` instead of browser-only network APIs.
- Prefer local-first behavior and clear disclosure when content is sent to a configured model or search endpoint.

## Good First Areas

- Documentation and setup examples for Ollama, LM Studio, vLLM, and OpenAI-compatible servers.
- UI polish for RAG chat, Related Notes, and workflow approvals.
- Retrieval quality improvements that keep behavior explainable and user-controlled.
- Bug reports with clear reproduction steps and Obsidian version details.

## Reporting Issues

Please include:

- Obsidian version and operating system.
- Plugin version.
- Provider and model setup, if relevant.
- Steps to reproduce.
- Expected behavior and actual behavior.
- Console errors, if any.

Do not include private vault content, API keys, or sensitive prompts in public issues.
