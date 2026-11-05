import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import ESMServer from "@musistudio/llms";

const CJSModule = createRequire(import.meta.url)("@musistudio/llms");
const CJSServer = CJSModule.default;
const encode = (data) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
const reasoning = { choices: [{ delta: { reasoning: "Checking." }, finish_reason: null }] };
const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };

for (const [format, Server] of [["ESM", ESMServer], ["CJS", CJSServer]]) {
  test(`${format}: headers deadline`, { timeout: 5000 }, async (t) => {
    const setTimer = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) =>
      setTimer(callback, ms === 60_000 ? 100 : ms, ...args));
    let closed = false;
    const upstream = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const mode = JSON.parse(body).messages[0].content;
      if (mode === "no-headers") {
        response.on("close", () => { closed = true; });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 8; i++) {
        response.write(encode(reasoning));
        await delay(25);
      }
      response.end(`${new TextDecoder().decode(encode(finish))}data: [DONE]\n\n`);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const server = new Server({ initialConfig: { providers: [{
      name: "test", api_base_url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
      api_key: "test", models: ["model"], transformer: { use: ["openai"] },
    }] }, logger: false });
    server.app.listen = async () => "test";
    t.after(async () => {
      upstream.closeAllConnections();
      await server.app.close();
      await new Promise((resolve) => upstream.close(resolve));
    });
    await server.start();
    const request = (mode) => server.app.inject({ method: "POST", url: "/v1/messages",
      payload: { model: "test,model", stream: true, max_tokens: 32, messages: [{ role: "user", content: mode }] },
    });
    // Bound the unpatched regression run as well as cleanup on assertion failure.
    const cleanup = setTimer(() => upstream.closeAllConnections(), 1000);
    t.after(() => clearTimeout(cleanup));
    const timeout = await request("no-headers");
    assert.equal(timeout.statusCode, 504);
    assert.equal(timeout.json().error.code, "upstream_headers_timeout");
    assert.match(timeout.json().error.message, /response headers within 60 seconds/);
    for (let i = 0; i < 20 && !closed; i++) await delay(10);
    assert.equal(closed, true, "headers timeout must abort the upstream request");
    const normal = await request("active-body");
    assert.equal(normal.statusCode, 200);
    assert.match(normal.body, /event: message_stop/);
    assert.doesNotMatch(normal.body, /event: error/);
  });
  test(`${format}: stream lifecycle`, async (t) => {
    const server = new Server({ initialConfig: { providers: [] }, logger: false });
    const transformer = server.transformerService.getAllTransformers().get("Anthropic");
    transformer.logger = { debug() {}, error() {} };
    t.after(() => server.app.close());

    const open = async (chunks = [reasoning]) => {
      let input, cancelled;
      const source = new ReadableStream({
        start(controller) {
          input = controller;
          for (const chunk of chunks) controller.enqueue(encode(chunk));
        },
        cancel(reason) { cancelled = reason; },
      });
      const output = await transformer.convertOpenAIStreamToAnthropic(source, { req: { id: "test" } });
      const body = new Response(output).text();
      // Always settle the pump, including on a failed regression assertion.
      t.after(async () => {
        try { input.error(new Error("test cleanup")); } catch {}
        await body.catch(() => {});
      });
      return { input, body, source, get cancelled() { return cancelled; } };
    };
    const read = (body) => Promise.race([
      body,
      delay(500, "pending"),
    ]);

    await t.test("silent stream emits an error and cancels upstream", async (t) => {
      const setTimer = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) =>
        setTimer(callback, ms === 60_000 ? 25 : ms, ...args));
      const stream = await open();
      const text = await read(stream.body);
      assert.notEqual(text, "pending", "silent upstream must not leave the response pending");
      assert.match(text, /event: error\ndata: .*"error":\{"type":"api_error"/);
      assert.match(text, /idle/i);
      assert.doesNotMatch(text, /event: message_stop/);
      assert(stream.cancelled instanceof Error);
    });

    await t.test("upstream read failure becomes an SSE error", async () => {
      const stream = await open();
      stream.input.error(new Error("simulated connection failure"));
      const text = await read(stream.body);
      assert.match(text, /event: error\ndata: .*"error":\{"type":"api_error"/);
      assert.match(text, /simulated connection failure/);
      assert.doesNotMatch(text, /event: message_stop/);
      assert.equal(stream.source.locked, false);
    });

    await t.test("incoming chunks reset the idle deadline", async (t) => {
      const setTimer = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) =>
        setTimer(callback, ms === 60_000 ? 150 : ms, ...args));
      const stream = await open();
      for (let i = 0; i < 5; i++) {
        await delay(50);
        stream.input.enqueue(encode(reasoning));
      }
      stream.input.enqueue(encode(finish));
      stream.input.close();
      const text = await read(stream.body);
      assert.match(text, /event: message_stop/);
      assert.doesNotMatch(text, /event: error/);
    });

    await t.test("EOF and DONE without finish_reason are incomplete", async () => {
      for (const done of [false, true]) {
        const stream = await open();
        if (done) stream.input.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        stream.input.close();
        const text = await read(stream.body);
        assert.match(text, /event: error/);
        assert.doesNotMatch(text, /event: message_stop/);
      }
    });

    await t.test("upstream error event terminates without fabricated success", async () => {
      const stream = await open([{ error: { message: "backend failed" } }]);
      const text = await read(stream.body);
      assert.match(text, /"error":\{"type":"api_error"/);
      assert.match(text, /backend failed/);
      assert.doesNotMatch(text, /event: message_stop/);
      assert(stream.cancelled instanceof Error);
    });

    await t.test("finish, usage and DONE in one chunk close an otherwise open connection", async () => {
      const stream = await open([]);
      const chunks = [
        reasoning,
        { choices: [{ delta: { content: "OK" }, finish_reason: null }] },
        finish,
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ];
      const data = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
      stream.input.enqueue(new TextEncoder().encode(`${data}data: [DONE]\n\n`));
      const text = await read(stream.body);
      assert.match(text, /"thinking_delta"/);
      assert.match(text, /"text_delta","text":"OK"/);
      assert.match(text, /"input_tokens":12,"output_tokens":3/);
      assert.match(text, /event: message_stop/);
      assert.doesNotMatch(text, /event: error/);
      assert.equal(stream.source.locked, false);
    });

    await t.test("reasoning-only completion is accepted with finish_reason", async () => {
      const stream = await open([reasoning, finish]);
      stream.input.close();
      const text = await read(stream.body);
      assert.match(text, /event: message_stop/);
      assert.doesNotMatch(text, /event: error/);
    });

    await t.test("client cancellation reaches a pending upstream reader", async () => {
      let reason;
      const source = new ReadableStream({ cancel(value) { reason = value; } });
      const output = await transformer.convertOpenAIStreamToAnthropic(source, { req: { id: "cancel" } });
      const result = await Promise.race([output.cancel("client left").then(() => "cancelled"), delay(500, "pending")]);
      assert.equal(result, "cancelled");
      assert.equal(reason, "client left");
      assert.equal(source.locked, false);
    });
  });
}

test("HTTP: idle timeout, errors and cancellation", { timeout: 70_000 }, async (t) => {
  const closed = new Map();
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const mode = JSON.parse(body).messages[0].content;
    response.on("close", () => closed.set(mode, true));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(encode(reasoning));
    if (mode === "truncated") response.end();
    if (mode === "error") {
      // Let the first fragment reach the client before breaking the socket.
      setTimeout(() => response.destroy(), 25);
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = new ESMServer({
    initialConfig: {
      PORT: "0",
      providers: [{
        name: "test",
        api_base_url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
        api_key: "test-key",
        models: ["model"],
        transformer: { use: ["openai"] },
      }],
    },
    logger: false,
  });
  t.after(async () => {
    upstream.closeAllConnections();
    server.app.server.closeAllConnections();
    await server.app.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  await server.start();
  const request = (mode, signal) => fetch(`http://127.0.0.1:${server.app.server.address().port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test,model", max_tokens: 128, stream: true, messages: [{ role: "user", content: mode }] }),
    signal,
  });
  for (const mode of ["truncated", "error"]) {
    const response = await request(mode);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: error\ndata: .*"error":\{"type":"api_error"/);
    assert.doesNotMatch(text, /event: message_stop/);
  }
  const abort = new AbortController();
  const response = await request("cancel", abort.signal);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !closed.get("cancel"); i++) await delay(10);
  assert.equal(closed.get("cancel"), true, "client abort must close the upstream HTTP connection");
  const start = Date.now();
  const idle = await request("idle");
  const text = await idle.text();
  assert.match(text, /event: error\ndata: .*"message":"Upstream stream idle for 60 seconds"/);
  assert.doesNotMatch(text, /event: message_stop/);
  assert(Date.now() - start >= 59_500, "HTTP test must exercise the real 60-second deadline");
  for (let i = 0; i < 50 && !closed.get("idle"); i++) await delay(10);
  assert.equal(closed.get("idle"), true, "idle timeout must close the upstream HTTP connection");
});
