# Rubytech patches

This branch is based on `claude-code-router` 1.0.73
(`a7e20325dbb2a8827db0c9ee12924bdecfa19fd9`) and carries compatibility and
streaming reliability fixes for the Rubytech vLLM gateway:

- Map Anthropic `tool_choice: any` to OpenAI `tool_choice: required`.
- Map streamed OpenAI `delta.reasoning` to Anthropic `thinking_delta` events.
- Forward the selected Claude effort to `reasoning_effort` for Rubytech GLM-5.3;
  preserve `low`, `high`, and `max`, and map `medium` to `high`.
- Abort requests after 60 seconds without response headers, returning HTTP 504
  with error code `upstream_headers_timeout`.
- Bound upstream body idle time to 60 seconds and emit Anthropic SSE errors for
  idle, failed, or incomplete streams.
- Propagate stream cancellation upstream and process usage and `[DONE]` after
  the finish chunk without waiting for the connection to close.

These changes patch both builds of `@musistudio/llms` 1.0.51 through
pnpm's `patchedDependencies`. A frozen install therefore reproduces the same
router build without editing generated `dist/cli.js` after installation.

See [patch details](patches/README.md) for timeout behavior and test coverage.

```sh
pnpm install --frozen-lockfile
pnpm test:rubytech-patches
pnpm build
```
