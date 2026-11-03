# Rubytech patches

This branch is based on `claude-code-router` 1.0.73
(`a7e20325dbb2a8827db0c9ee12924bdecfa19fd9`) and carries two compatibility
fixes for the Rubytech vLLM gateway:

- Map Anthropic `tool_choice: any` to OpenAI `tool_choice: required`.
- Map streamed OpenAI `delta.reasoning` to Anthropic `thinking_delta` events.

Both changes patch the bundled `@musistudio/llms` 1.0.51 package through
pnpm's `patchedDependencies`. A frozen install therefore reproduces the same
router build without editing generated `dist/cli.js` after installation.

```sh
pnpm install --frozen-lockfile
pnpm test:rubytech-patches
pnpm build
```
