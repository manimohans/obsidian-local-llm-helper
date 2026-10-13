# Contributing to Local LLM Helper

Thanks for helping improve Local LLM Helper. This plugin is built for Obsidian users who want private, local-first AI workflows, so contributions should keep user control and vault safety at the center.

## Development Setup

1. Install Node.js 22.13 or later and clone the repository.
2. Install dependencies:

```bash
npm ci
```

3. Run the lint, test, and production-build gate:

```bash
npm run check
```

4. For local Obsidian testing, copy or symlink the repository into:

```text
<vault>/.obsidian/plugins/obsidian-local-llm-helper
```

Then reload Obsidian or disable and re-enable the plugin.

## Before Opening a Pull Request

- Run `npm run check`.
- Keep changes focused and avoid unrelated formatting churn.
- Do not add telemetry, analytics, or background network behavior.
- Keep vault writes behind explicit user approval.
- Route OpenAI-compatible model requests through `OpenAICompatibleClient`; keep Obsidian's `requestUrl` isolated in the transport adapter.
- Use Obsidian APIs such as `requestUrl` instead of browser-only network APIs for unrelated integrations.
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

## Releases

Releases use an annotated tag such as `2.6.1` (no `v` prefix). The tag-triggered
GitHub Actions workflow validates metadata, installs from the lockfile, runs
`npm run check`, attests the artifacts, and publishes `main.js`, `manifest.json`,
and `styles.css`. Do not commit the generated bundle.

1. Review the changes, including dependency alerts. Preserve contributor authorship.
2. Run `npm ci`, `npm run check`, and `npm audit --audit-level=moderate` locally.
3. Exercise changed runtime behavior in a test vault or browser harness. In particular,
   check PDF extraction from a cold start and with an existing PDF worker, settings
   controls on supported API versions, and closing/clearing chats during requests.
4. Set the same release version in `package.json`, both root version fields in
   `package-lock.json`, and `manifest.json`; add its minimum Obsidian version to
   `versions.json`. Update the in-app changelog in `src/updateNoticeModal.ts`.
5. Commit and push the reviewed changes to `main`; wait for that commit's CI to pass.
6. Create an annotated tag on that commit using the reviewed release notes, then push
   the tag. The workflow reads the release body from the tag annotation.
7. Verify the release workflow, tag commit, three downloadable artifacts, and artifact
   attestations. Compare downloaded asset hashes with the local production build.
8. Recheck Dependabot and the community listing. A published release does not prove
   the directory has rescanned it; report the listing's observed version and score.

The lint configuration follows Obsidian's documented community scanner configuration,
with canonical product names and literal examples preserved by the sentence-case rule.
The command fails on warnings as well as errors. Build and test files are excluded
from the plugin-source scan, as they are in the community scanner.
