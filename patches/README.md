# Rubytech compatibility patch

`@musistudio__llms@1.0.51.patch` applies to both the ESM and CommonJS builds of
`@musistudio/llms` 1.0.51. Keep both builds in sync.

The patch maps Anthropic `tool_choice: any` to OpenAI `required` and forwards
OpenAI `delta.reasoning` as Anthropic thinking events.

For `just-ai/vllm-glm-5-3-fp8`, an explicit Anthropic `output_config.effort`
is forwarded as the Chat Completions `reasoning_effort`: `low` → `low`,
`medium` → `high`, `high` → `high`, and `max` → `max`. The legacy `reasoning`
object is omitted for these requests to avoid conflicting thinking flags.
Invalid explicit values return HTTP 400 before any upstream request. Requests
without an explicit effort and requests for other models keep their existing
behavior. The response token budget is unchanged.

Outbound requests have a separate 60-second response-headers deadline. If the
upstream does not send headers in time, CCR aborts the request and returns HTTP
504 with `error.code: upstream_headers_timeout` and an explanatory message.
Receiving headers clears this timer; it does not limit an active response body.

For OpenAI responses converted to Anthropic streams, it also:

- Fails after 60 seconds without an upstream body chunk. Each received chunk
  resets this deadline; it is independent of the total request timeout.
- Emits an Anthropic SSE `error` event on idle timeout, upstream read failure,
  upstream error events, or an incomplete response. Failed responses do not
  emit a successful `message_stop`.
- Requires `finish_reason` before accepting EOF or `[DONE]`. After a finish
  chunk, it continues processing usage and `[DONE]`, including when they arrive
  in the same network chunk. `[DONE]` closes the converted stream immediately.
- Cancels the upstream reader on client cancellation, failure, or completion.
  Cancelling a fetch response body closes the upstream HTTP connection.

Run `pnpm run test:rubytech-patches` to check both module formats and HTTP
streaming. The headers-deadline tests accelerate the timer and check upstream
cancellation and an active body that lasts longer than the headers deadline.
The HTTP idle-timeout regression uses the real 60-second deadline.
Run `pnpm run build` to build the installable CLI and UI.
