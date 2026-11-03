import assert from "node:assert/strict";
import http from "node:http";
import Server from "@musistudio/llms";

const upstreamRequests = [];
const upstream = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  upstreamRequests.push(JSON.parse(body));

  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunks = upstreamRequests.length === 1
    ? [
        { id: "response-1", model: "test-model", choices: [{ index: 0, delta: { reasoning: "Checking the tool." }, finish_reason: null }] },
        { id: "response-1", model: "test-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "demo", arguments: '{"value":"ok"}' } }] }, finish_reason: null }] },
        { id: "response-1", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]
    : [
        { id: "response-2", model: "test-model", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
        { id: "response-2", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1 } },
      ];

  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
assert(address && typeof address === "object");

const server = new Server({
  initialConfig: {
    providers: [{
      name: "rubytech-test",
      api_base_url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      api_key: "test-key",
      models: ["test-model"],
      transformer: { use: ["openai"] },
    }],
  },
  logger: false,
});
server.app.listen = async () => "test";
await server.start();

const request = async (payload) => server.app.inject({
  method: "POST",
  url: "/v1/messages",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  payload: {
    model: "rubytech-test,test-model",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "test" }],
    ...payload,
  },
});

try {
  const toolResponse = await request({
    tools: [{ name: "demo", description: "Test tool", input_schema: { type: "object", properties: { value: { type: "string" } } } }],
    tool_choice: { type: "any" },
  });
  assert.equal(toolResponse.statusCode, 200);
  assert.equal(upstreamRequests[0].tool_choice, "required");
  assert.match(toolResponse.body, /"type":"thinking_delta","thinking":"Checking the tool\."/);
  assert.match(toolResponse.body, /"type":"tool_use"/);
  assert.match(toolResponse.body, /"name":"demo"/);
  assert.match(toolResponse.body, /"type":"input_json_delta"/);

  const textResponse = await request({});
  assert.equal(textResponse.statusCode, 200);
  assert.match(textResponse.body, /"type":"text_delta","text":"OK"/);
  console.log("Rubytech patches passed: tool_choice, reasoning stream, tool call, text stream");
} finally {
  await server.app.close();
  await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
}
