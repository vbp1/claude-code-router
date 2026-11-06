import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import ESMServer from "@musistudio/llms";

const CJSServer = createRequire(import.meta.url)("@musistudio/llms").default;
const glm = "just-ai/vllm-glm-5-3-fp8";

for (const [format, Server] of [["ESM", ESMServer], ["CJS", CJSServer]]) {
  test(`${format}: Claude effort reaches GLM Chat Completions`, async (t) => {
    const sent = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const server = new Server({ initialConfig: { providers: [{
      name: "rubytech", api_base_url: "http://test.invalid/v1/chat/completions",
      api_key: "test", models: [glm, "other-model"], transformer: { use: ["openai"] },
    }] }, logger: false });
    server.app.listen = async () => "test";
    t.after(() => server.app.close());
    await server.start();
    const request = (extra = {}) => server.app.inject({
      method: "POST", url: "/v1/messages",
      payload: { model: `rubytech,${glm}`, stream: true, max_tokens: 32000,
        thinking: { type: "adaptive", display: "updates" },
        messages: [{ role: "user", content: "test" }], ...extra },
    });
    for (const [input, expected] of [["low", "low"], ["medium", "high"], ["high", "high"], ["max", "max"]]) {
      const response = await request({ output_config: { effort: input } });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /event: message_stop/);
      const { url, body } = sent.at(-1);
      assert.equal(url, "http://test.invalid/v1/chat/completions");
      assert.equal(body.reasoning_effort, expected);
      assert.equal(body.reasoning, undefined, "must not send conflicting legacy reasoning flags");
      assert.equal(body.max_tokens, 32000, "effort must not truncate the response budget");
    }
    await request({ thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "max" } });
    assert.equal(sent.at(-1).body.reasoning_effort, "max", "explicit effort takes precedence over legacy budget");
    await request({ output_config: { effort: "low" }, thinking: undefined });
    assert.equal(sent.at(-1).body.reasoning_effort, "low", "effort does not require a thinking block");
    const count = sent.length;
    for (const effort of ["invalid", null, 0]) {
      const response = await request({ output_config: { effort } });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error.message, /low, medium, high, max/);
    }
    assert.equal(sent.length, count, "invalid effort must not reach upstream");
    await request({ output_config: { effort: "medium" }, model: "rubytech,other-model" });
    assert.equal(sent.at(-1).body.reasoning_effort, undefined, "GLM mapping must not affect other models");
    await request();
    assert.equal(sent.at(-1).body.reasoning_effort, undefined, "do not invent an effort absent from the request");
  });
}
