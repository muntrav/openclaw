import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { normalizeOpenAIResponsesFunctionCallId } from "./openai-responses-tool-call-id-shape.js";

// Proxy backends can return noncanonical IDs; replay must restore their raw wire IDs.
async function scriptedServer(script: string[]) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    const index = requests.length;
    requests.push(JSON.parse(body));
    const frame = script[index];
    res.writeHead(frame ? 200 : 500, {
      "content-type": frame ? "text/event-stream" : "application/json",
      "cache-control": "no-cache",
    });
    res.end(
      frame
        ? `data: ${frame}\n\n`
        : JSON.stringify({ error: { message: `no scripted response for request ${index}` } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    await promisify(server.close.bind(server))();
    cleanupSessionResources();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { requests, model: customEndpointModel(`http://127.0.0.1:${address.port}/v1`) };
}

const RAW_CALL_ID = "functions.gateway:0";
const RAW_ITEM_ID = "fc_tmp_kegospxl46";

function completedFrame(responseId: string, output: unknown[]): string {
  return JSON.stringify(
    fixtures.completedResponse(responseId, output, { usage: fixtures.responseUsage }),
  );
}

function toolCallCompletedFrame(responseId: string, colliding = false): string {
  const calls = colliding
    ? [
        { id: "fc_1", call_id: " x", name: "first" },
        { id: "fc_1", call_id: "x", name: "second" },
      ]
    : [{ id: RAW_ITEM_ID, call_id: RAW_CALL_ID, name: "gateway" }];
  return completedFrame(
    responseId,
    calls.map((call) =>
      Object.assign(call, { type: "function_call", status: "completed", arguments: "{}" }),
    ),
  );
}

function textCompletedFrame(responseId: string, content: string): string {
  return completedFrame(responseId, [fixtures.outputMessage(content, `msg_${responseId}`)]);
}

function customEndpointModel(baseUrl: string): Model<"openai-responses"> {
  return Object.assign(
    fixtures.createModel({
      id: "scripted-model",
      name: "Scripted Model",
      provider: "omniroute",
      baseUrl,
      compat: { supportsResponsesContinuation: true },
    }),
    { [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true } },
  );
}

async function run(
  model: Model<"openai-responses">,
  messages: Context["messages"],
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, { messages, tools: [] }, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

describe("HTTP continuation across a non-canonical replayed tool-call id (loopback server, no SDK mocking)", () => {
  it("reshapes, matches, and restores a raw non-canonical call_id/id pair on continuation", async () => {
    const server = await scriptedServer([
      toolCallCompletedFrame("resp_1"),
      textCompletedFrame("resp_2", "recorded"),
    ]);
    const { model } = server;
    const sessionId = "real-sse-noncanonical-id";
    const firstUser = fixtures.userMessage("call the gateway tool", 1);
    const callTurn = await run(model, [firstUser], sessionId);

    const toolCall = callTurn.content.find((block) => block.type === "toolCall");
    assert(toolCall, "Expected a completed tool call");
    expect(toolCall.id).toBe(`${RAW_CALL_ID}|${RAW_ITEM_ID}`);

    // Match the agent's transcript normalization without importing its wrapper.
    const reshapedId = normalizeOpenAIResponsesFunctionCallId(toolCall.id);
    expect(reshapedId).not.toBe(toolCall.id);
    expect(reshapedId.endsWith(`|${RAW_ITEM_ID}`)).toBe(true);
    const reshapedToolCall = { ...callTurn, content: [{ ...toolCall, id: reshapedId }] };

    const toolResultMsg = makeTextToolResult(reshapedId, "gateway", "recorded", false, 2);
    const afterToolResult = await run(
      model,
      [firstUser, reshapedToolCall, toolResultMsg],
      sessionId,
    );
    expect(afterToolResult.stopReason).toBe("stop");

    expect(server.requests).toHaveLength(2);
    const secondRequest = server.requests[1];
    expect(secondRequest).toHaveProperty("previous_response_id", "resp_1");
    expect(secondRequest?.input).toEqual([
      { type: "function_call_output", call_id: RAW_CALL_ID, output: "recorded" },
    ]);
  });

  it("resends full history when distinct cached calls share a replay ID shape", async () => {
    const server = await scriptedServer([
      toolCallCompletedFrame("resp_1", true),
      textCompletedFrame("resp_2", "recorded"),
    ]);
    const { model } = server;
    const sessionId = "real-sse-ambiguous-noncanonical-ids";
    const firstUser = fixtures.userMessage("call both tools", 1);
    const callTurn = await run(model, [firstUser], sessionId);
    const toolCalls = callTurn.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toHaveLength(2);
    const replayedToolCalls = toolCalls.map((toolCall) =>
      Object.assign({}, toolCall, { id: normalizeOpenAIResponsesFunctionCallId(toolCall.id) }),
    );
    expect(replayedToolCalls[0]?.id).toBe(replayedToolCalls[1]?.id);
    const toolResults = replayedToolCalls.map((call, index) =>
      makeTextToolResult(call.id, call.name, `result ${index + 1}`, false, index + 2),
    );
    const messages: Context["messages"] = [
      firstUser,
      { ...callTurn, content: replayedToolCalls },
      ...toolResults,
    ];
    const afterToolResults = await run(model, messages, sessionId);

    expect(afterToolResults.stopReason).toBe("stop");
    expect(server.requests).toHaveLength(2);
    const secondRequest = server.requests[1];
    expect(secondRequest).not.toHaveProperty("previous_response_id");
    const input = secondRequest?.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.type === "function_call")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output")).toBe(true);
  });

  it("stores and advances only new messages across three real chained turns", async () => {
    const questions = ["first question", "second question", "third question"];
    const server = await scriptedServer(
      questions.map((_, index) => textCompletedFrame(`resp_${index + 1}`, `answer ${index + 1}`)),
    );
    const { model } = server;
    const context: Context = { messages: [], tools: [] };
    for (const [index, content] of questions.entries()) {
      context.messages.push({ role: "user", content, timestamp: index + 1 });
      const options = {
        apiKey: "test-key",
        sessionId: "real-sse-store-policy",
        transport: "sse",
        reasoningEffort: "low",
      } satisfies OpenAIResponsesOptions;
      const stream = await createOpenAIResponsesTransportStreamFn()(model, context, options);
      context.messages.push(await stream.result());
    }
    const { requests } = server;
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.store)).toEqual([true, true, true]);
    expect(requests[0]).not.toHaveProperty("previous_response_id");
    expect(requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(requests[2]).toMatchObject({ previous_response_id: "resp_2" });
    expect(requests.slice(1).map((request) => request.input)).toEqual(
      ["second question", "third question"].map((text) => [fixtures.inputMessage(text)]),
    );
  });
});
