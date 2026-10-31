#!/usr/bin/env node
// ccr 的本地补丁（幂等；CCR 升级覆盖 dist/cli.js 后由 start-bridge.sh 重打）：
//
// 1) effort 映射：Claude Code 发 thinking:{type:"adaptive"} + output_config:{effort:"max"}，
//    旧逻辑只认 thinking.budget_tokens → 上游恒为 reasoning.effort=high、enabled=false。
//    中转站只认顶层 reasoning_effort，这里把 output_config.effort 原样写过去。
//
// 2) 未捕获异常兜底：自带处理器写的是 server.logger.error(...)，但 server 上没有 logger，
//    于是任何未捕获异常都会再抛一次 TypeError，把整个进程带走。实测「会话里点停止」必触发，
//    结果一个会话一停，所有走中转站的会话全断。改成记日志、不让兜底自己崩。
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");

const file = path.join(__dirname, "node_modules/@musistudio/claude-code-router/dist/cli.js");

const EFF_OLD = 'e.thinking && (o.reasoning = { effort: Vf(e.thinking.budget_tokens), enabled: e.thinking.type === "enabled" })';
const EFF_NEW = '(e.output_config && e.output_config.effort ? (o.reasoning_effort = e.output_config.effort, o.reasoning = { effort: e.output_config.effort, enabled: true }) : e.thinking && (o.reasoning = { effort: Vf(e.thinking.budget_tokens), enabled: e.thinking.type === "enabled" }))';
const EFF_MARK = "reasoning_effort = e.output_config.effort";

const UE_OLD = 'server.logger.error("Uncaught exception:", err);';
const UE_NEW = 'try { server.logger.error("Uncaught exception:", err); } catch (e) { console.error("Uncaught exception:", err); }';
const UR_OLD = 'server.logger.error("Unhandled rejection at:", promise, "reason:", reason);';
const UR_NEW = 'try { server.logger.error("Unhandled rejection at:", promise, "reason:", reason); } catch (e) { console.error("Unhandled rejection at:", promise, "reason:", reason); }';

// 3) 客户端断开（会话里点停止）时，上游请求根本没有被取消，只是记了句 cancle stream。
//    中转站按账号串行，几个被放弃的请求就能把后面的会话全堵死 —— 表现就是「只能一个会话用」。
//    把读流的 reader 挂到流上，cancel 时一并取消，上游连接才会真正释放。
const READER_OLD = 'Y = e.getReader();';
const READER_NEW = 'Y = e.getReader(), e._ccrReader = Y;';
const CANCEL_OLD = 'this.logger.debug({ reqId: t.req.id }, `cancle stream: ${o}`);';
const CANCEL_NEW = 'this.logger.debug({ reqId: t.req.id }, `cancle stream: ${o}`); try { (e._ccrReader || e).cancel(o).catch(() => {}); } catch {}';

// 4) 客户端断开后，Fastify 的错误处理器往已经开始的 SSE 响应里塞 JSON 对象，
//    Fastify 不认（FST_ERR_REP_INVALID_PAYLOAD_TYPE），又变成未捕获的 Promise rejection。
//    已经发过响应头就直接收尾，不再塞对象；未发过才按 JSON 返回。
const H_OLD = `  e.log.error(r);
  let n = r.statusCode || 500, o = { error: { message: r.message + r.stack || "Internal Server Error", type: r.type || "api_error", code: r.code || "internal_error" } };
  return t.code(n).send(o);`;
const H_NEW = `  (r && (r.code === "ERR_STREAM_PREMATURE_CLOSE" || /Premature close/.test(r.message || ""))) ? e.log.debug(r) : e.log.error(r);
  if (t.raw && (t.raw.headersSent || t.raw.writableEnded || t.raw.destroyed)) { try { t.raw.end(); } catch {} return; }
  let n = r.statusCode || 500, o = { error: { message: r.message + r.stack || "Internal Server Error", type: r.type || "api_error", code: r.code || "internal_error" } };
  return t.code(n).type("application/json").send(o);`;

// 5) 每条请求体都按 info 级别整段写日志（226k tokens 的会话一写就是几 MB）。
//    降到 debug：平时不写，真要查问题时把 config.json 的 LOG_LEVEL 临时调回 debug 即可。
const BODY_OLD = 'n.log.info({ data: n.body, type: "request body" })';
const BODY_NEW = 'n.log.debug({ data: n.body, type: "request body" })';

// 6) 上游 fetch 复用 keep-alive 连接：中转站把旧连接静默掐掉时，Node 会一直等。
//    实测同一条请求：直连首字 16s，走桥 67s（重启桥后 23s），最长 154s 零字节。
//    每次请求用新的 Agent，不复用连接；TLS 握手多几百毫秒，远比等 40 秒划算。
const AGENT_OLD = `  let c = { method: "POST", headers: i, body: JSON.stringify(e), signal: u };`;
const AGENT_NEW = `  let c = { method: "POST", headers: i, body: JSON.stringify(e), signal: u };
  c.dispatcher = new import_undici.Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1, pipelining: 0 });`;

// 7) 非流式请求漏了 stream:false：Claude Code 有些调用不带 stream 字段，
//    上游会默认按流式回 SSE，但 content-type 仍是 application/json，桥按 JSON 解析就报
//    Unexpected token 'd'，App 于是重试到 5/10 次。显式发 boolean false。
const STREAM_OLD = 'stream: e.stream, tools: e.tools?.length';
const STREAM_NEW = 'stream: e.stream === true, tools: e.tools?.length';

// 8) 中转站可能把 SSE 标成 application/json，也可能给 stream:true 返回真实 JSON。
//    不能用客户端的 stream 字段猜响应格式：先读正文前缀，再把已读部分接回同一个 reader。
//    SSE 按事件校验/规范化后交给原转换器；JSON 按原逻辑转换，流式客户端再包装成 Anthropic SSE。
const SSE_OLD = `  async transformResponseIn(e, t) {
    if (e.headers.get("Content-Type")?.includes("text/event-stream")) {
      if (!e.body) throw new Error("Stream response body is null");
      let o = await this.convertOpenAIStreamToAnthropic(e.body, t);
      return new Response(o, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    } else {
      let o = await e.json(), i = this.convertOpenAIResponseToAnthropic(o, t);
      return new Response(JSON.stringify(i), { headers: { "Content-Type": "application/json" } });
    }
  }
`;
// 上一版错误的 fallback 也要能升级；只认本版专用标记，不能拿 stream:true 判断是否已打补丁。
const SSE_FALLBACK = SSE_OLD.replace('?.includes("text/event-stream")) {', '?.includes("text/event-stream") || (t && t.req && t.req.body && t.req.body.stream === true)) {');
const SSE_MARK = "// ccr-response-v2: sniff JSON/SSE";
const SSE_NEW = `  async transformResponseIn(e, t) {
    // ccr-response-v2: sniff JSON/SSE
    let bad = (message) => nt("Provider error: " + message, e.ok ? 502 : e.status, "provider_error");
    if (!e.body) throw bad("Response body is null");
    let reader = e.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }), text = "", ended = false, released = false;
    let raw = t?.req?.raw, socket = raw?.socket, disconnected;
    let close = async (reason) => {
      if (released) return;
      released = true;
      raw?.off?.("aborted", onDisconnect);
      socket?.off?.("close", onDisconnect);
      try { if (!ended) await reader.cancel(reason); } catch {} finally { reader.releaseLock(); }
    };
    let onDisconnect = () => {
      disconnected = nt("Client disconnected", 499, "ERR_STREAM_PREMATURE_CLOSE");
      void close(disconnected);
    };
    // 嗅探前缀/等待首帧时还没返回输出流，不能只依赖输出流的 cancel。
    raw?.once?.("aborted", onDisconnect);
    socket?.once?.("close", onDisconnect);
    if (raw?.aborted || socket?.destroyed) onDisconnect();
    let read = async () => {
      if (disconnected) throw disconnected;
      let part = await reader.read();
      if (disconnected) throw disconnected;
      ended = part.done;
      try { text += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true }); }
      catch { throw bad("Invalid UTF-8 payload"); }
    };
    let object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    let check = (value, streaming, seen) => {
      if (!object(value)) throw bad("Expected an OpenAI response object");
      if (value.error != null) throw bad(typeof value.error === "string" ? value.error : JSON.stringify(value.error));
      if (!streaming && (typeof value.id !== "string" || !value.id || typeof value.model !== "string" || !value.model)) throw bad("Missing response id/model");
      if (value.usage != null) {
        if (!object(value.usage)) throw bad("Invalid usage");
        for (let count of [value.usage.prompt_tokens, value.usage.completion_tokens, value.usage.prompt_tokens_details?.cached_tokens]) {
          if (count != null && (!Number.isFinite(count) || count < 0)) throw bad("Invalid token usage");
        }
      }
      if (!Array.isArray(value.choices)) throw bad("Missing choices");
      let choice = value.choices[0];
      if (!choice && streaming && seen && value.choices.length === 0 && value.usage) return;
      if (!object(choice)) throw bad("No choices found in OpenAI response");
      if (choice.finish_reason != null && !["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) throw bad("Invalid finish reason");
      let message = streaming ? choice.delta : choice.message;
      if (!object(message)) throw bad(streaming ? "Missing choice delta" : "Missing choice message");
      if (message.content != null && typeof message.content !== "string") throw bad("Invalid message content");
      if (message.thinking != null && (!object(message.thinking) || [message.thinking.content, message.thinking.signature].some((v) => v != null && typeof v !== "string"))) throw bad("Invalid thinking content");
      if (message.annotations != null && (!Array.isArray(message.annotations) || message.annotations.some((a) => !a?.url_citation || typeof a.url_citation.url !== "string" || typeof a.url_citation.title !== "string"))) throw bad("Invalid annotations");
      if (message.tool_calls != null) {
        if (!Array.isArray(message.tool_calls)) throw bad("Invalid tool calls");
        for (let tool of message.tool_calls) {
          if (!object(tool) || !object(tool.function)) throw bad("Invalid tool call");
          if (streaming) {
            if (tool.index != null && (!Number.isInteger(tool.index) || tool.index < 0)) throw bad("Invalid tool index");
            if ((tool.id != null && typeof tool.id !== "string") || (tool.function.name != null && typeof tool.function.name !== "string")) throw bad("Invalid tool id/name");
            if (tool.function.arguments != null && typeof tool.function.arguments !== "string") throw bad("Invalid tool arguments delta");
          } else {
            if (typeof tool.id !== "string" || !tool.id || typeof tool.function.name !== "string" || !tool.function.name) throw bad("Missing tool id/name");
            let input = tool.function.arguments ?? "{}";
            try { if (typeof input === "string") input = JSON.parse(input); } catch { throw bad("Invalid tool arguments JSON"); }
            if (!object(input)) throw bad("Invalid tool arguments object");
          }
        }
      }
      if (!streaming && typeof message.content !== "string" && !message.tool_calls?.length && !message.thinking?.content && !message.annotations?.length) throw bad("Missing message content");
      return choice;
    };
    let parse = (data) => {
      try { return JSON.parse(data); } catch { throw bad("Invalid JSON payload"); }
    };
    try {
      if (!e.ok) throw bad("Upstream HTTP " + e.status);
      let fields = ["data:", "event:", "id:", "retry:", ":"];
      for (;;) {
        // trimStart 也去掉 BOM；保留 TextDecoder 状态，前缀/UTF-8 字符跨块不会被吃掉。
        text = text.trimStart();
        if (ended || text && (fields.some((field) => text.startsWith(field)) || !fields.some((field) => field.startsWith(text)))) break;
        await read();
      }
      let headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
      if (fields.some((field) => text.startsWith(field))) {
        let seen = false, finished = false, stopped = false, canceled = false, meaningful = false, tools = new Map();
        let validateEnd = () => {
          if (!meaningful) throw bad("SSE response has no content");
          for (let tool of tools.values()) {
            let input;
            try { input = JSON.parse(tool.arguments || "{}"); } catch { throw bad("Invalid streamed tool arguments JSON"); }
            if (!tool.id || !tool.name || !object(input)) throw bad("Invalid streamed tool call");
          }
        };
        let line = async () => {
          for (;;) {
            let match = /\\r\\n|\\r|\\n/.exec(text);
            // 单独的 CR 可能只是分块的 CRLF 前半段，等下一块再判断。
            if (match && (match[0] !== "\\r" || match.index + 1 < text.length || ended)) {
              let result = text.slice(0, match.index);
              text = text.slice(match.index + match[0].length);
              return result;
            }
            if (ended) { let result = text || null; text = ""; return result; }
            await read();
          }
        };
        let complete = async () => {
          if (!seen || !finished) throw bad("Empty or incomplete SSE response");
          stopped = true;
          await close();
          return null;
        };
        let frame = async () => {
          if (stopped) return null;
          let data = [];
          for (;;) {
            let part = await line();
            if (part === null || part === "") {
              if (data.length) {
                let payload = data.join("\\n").trim();
                if (payload === "[DONE]") return complete();
                let value = parse(payload), choice = check(value, true, seen);
                if (choice) {
                  if (finished) throw bad("Choice received after SSE finish");
                  seen = true;
                  let delta = choice.delta;
                  if (delta.content || delta.thinking?.content || delta.annotations?.length) meaningful = true;
                  for (let part of delta.tool_calls || []) {
                    let index = part.index ?? 0, tool = tools.get(index) || { id: "", name: "", arguments: "" };
                    if (part.id) tool.id = part.id;
                    if (part.function.name) tool.name += part.function.name;
                    tool.arguments += part.function.arguments || "";
                    tools.set(index, tool);
                    meaningful = true;
                  }
                  if (choice.finish_reason) {
                    // length/content_filter 允许模型没有输出；普通 stop 不能把空/坏 payload 伪装成功。
                    if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") meaningful = true;
                    validateEnd();
                    finished = true;
                  }
                }
                // 每次只给原转换器一个事件，避免它在 finish 后跳过同块里的 usage 尾帧。
                return new TextEncoder().encode("data: " + JSON.stringify(value) + "\\n\\n");
              }
              if (part === null) return complete();
            } else if (part.startsWith("data:")) data.push(part.slice(5).replace(/^ /, ""));
          }
        };
        // 首帧错误在发响应头前抛出；后续错误让输出流失败，不再伪装空的成功响应。
        let first = await frame();
        let body = new ReadableStream({
          async pull(controller) {
            try {
              let value = first;
              first = null;
              if (!value) value = await frame();
              if (!canceled) value ? controller.enqueue(value) : controller.close();
            } catch (error) {
              await close(error);
              if (!canceled) controller.error(error);
            }
          },
          async cancel(reason) { canceled = true; await close(reason); }
        });
        return new Response(await this.convertOpenAIStreamToAnthropic(body, t), { headers });
      }
      while (!ended) await read();
      let value = parse(text);
      check(value, false);
      let message = this.convertOpenAIResponseToAnthropic(value, t);
      if (t?.req?.body?.stream !== true) return new Response(JSON.stringify(message), { headers: { "Content-Type": "application/json" } });
      // 真实 JSON 没有增量可读，但 stream:true 客户端仍必须收到合法的 Anthropic SSE。
      let events = [], send = (type, data) => events.push("event: " + type + "\\ndata: " + JSON.stringify({ type, ...data }) + "\\n\\n");
      send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
      message.content.forEach((block, index) => {
        let start = { ...block };
        if (block.type === "text") start.text = "";
        if (block.type === "tool_use") start.input = {};
        if (block.type === "thinking") { start.thinking = ""; delete start.signature; }
        send("content_block_start", { index, content_block: start });
        if (block.type === "text") send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        if (block.type === "tool_use") send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        if (block.type === "thinking") {
          send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
          if (block.signature) send("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
        }
        send("content_block_stop", { index });
      });
      send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: message.usage });
      send("message_stop", {});
      return new Response(events.join(""), { headers });
    } catch (error) {
      await close(error);
      throw error;
    } finally {
      if (ended) await close();
    }
  }
`;

// 9) tool_result 里的图片被 JSON.stringify 当成文字发出，base64 会白占几十万 tokens。
//    tool 消息只保留非图片内容与图片引用，图片作为正规的 user/image_url 内容发送。
//    相邻 user 消息可能是同批并行工具结果，必须先发完全部 tool 回复，再发图片/用户文本。
const TOOL_IMAGES_OLD = `    JSON.parse(JSON.stringify(e.messages || []))?.forEach((i) => {
      if (i.role === "user" || i.role === "assistant") {
        if (typeof i.content == "string") {
          t.push({ role: i.role, content: i.content });
          return;
        }
        if (Array.isArray(i.content)) {
          if (i.role === "user") {
            let u = i.content.filter((c) => c.type === "tool_result" && c.tool_use_id);
            u.length && u.forEach((c) => {
              let h = { role: "tool", content: typeof c.content == "string" ? c.content : JSON.stringify(c.content), tool_call_id: c.tool_use_id, cache_control: c.cache_control };
              t.push(h);
            });
            let f = i.content.filter((c) => c.type === "text" && c.text || c.type === "image" && c.source);
            f.length && t.push({ role: "user", content: f.map((c) => c?.type === "image" ? { type: "image_url", image_url: { url: c.source?.type === "base64" ? Kf(c.source.data, c.source.media_type) : c.source.url }, media_type: c.source.media_type } : c) });
          } else if (i.role === "assistant") {
            let u = { role: "assistant", content: "" }, f = i.content.filter((d) => d.type === "text" && d.text);
            f.length && (u.content = f.map((d) => d.text).join(\`\n\`));
            let c = i.content.filter((d) => d.type === "tool_use" && d.id);
            c.length && (u.tool_calls = c.map((d) => ({ id: d.id, type: "function", function: { name: d.name, arguments: JSON.stringify(d.input || {}) } })));
            let h = i.content.find((d) => d.type === "thinking" && d.signature);
            h && (u.thinking = { content: h.thinking, signature: h.signature }), t.push(u);
          }
          return;
        }
      }
    });`;
const TOOL_IMAGES_NEW = `    // ccr-tool-images-v1: never serialize image bytes as tool text
    let pendingUserMessages = [];
    let flushUserMessages = () => { t.push(...pendingUserMessages); pendingUserMessages = []; };
    let imageContent = (part) => {
      let source = part.source;
      let url = source.type === "base64" ? (source.data.startsWith("data:") ? source.data : "data:" + source.media_type + ";base64," + source.data) : source.url;
      return { type: "image_url", image_url: { url }, media_type: source.media_type };
    };
    JSON.parse(JSON.stringify(e.messages || []))?.forEach((i) => {
      if (i.role !== "user" && i.role !== "assistant") return;
      if (i.role === "assistant") flushUserMessages();
      if (typeof i.content === "string") {
        (i.role === "user" ? pendingUserMessages : t).push({ role: i.role, content: i.content });
        return;
      }
      if (!Array.isArray(i.content)) return;
      if (i.role === "user") {
        let images = [];
        i.content.filter((c) => c.type === "tool_result" && c.tool_use_id).forEach((c) => {
          let parts = c.content, index = 0;
          if (Array.isArray(parts)) parts = parts.map((part) => {
            if (part.type !== "image" || !part.source) return part;
            index++;
            images.push({ type: "text", text: "Tool result " + c.tool_use_id + ", image " + index + ":" }, imageContent(part));
            return { type: "text", text: "[Image " + index + " from tool result " + c.tool_use_id + " is provided in the following user message.]" };
          });
          t.push({ role: "tool", content: typeof parts === "string" ? parts : JSON.stringify(parts), tool_call_id: c.tool_use_id, cache_control: c.cache_control });
        });
        let content = images.concat(i.content.filter((c) => c.type === "text" && c.text || c.type === "image" && c.source).map((c) => c.type === "image" ? imageContent(c) : c));
        if (content.length) pendingUserMessages.push({ role: "user", content });
      } else {
        let u = { role: "assistant", content: "" }, f = i.content.filter((d) => d.type === "text" && d.text);
        if (f.length) u.content = f.map((d) => d.text).join("\\n");
        let c = i.content.filter((d) => d.type === "tool_use" && d.id);
        if (c.length) u.tool_calls = c.map((d) => ({ id: d.id, type: "function", function: { name: d.name, arguments: JSON.stringify(d.input || {}) } }));
        let h = i.content.find((d) => d.type === "thinking" && d.signature);
        if (h) u.thinking = { content: h.thinking, signature: h.signature };
        t.push(u);
      }
    });
    flushUserMessages();`;

// 10) 路由和 count_tokens 也会把工具图片当文字编码。按视觉块粗估，不再编码 base64。
//     4096 是本地占位估算，不是任一上游模型的精确图片计费；实际以响应 usage 为准。
const IMAGE_TOKENS_OLD = `          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string" ? contentPart.content : JSON.stringify(contentPart.content)
            ).length;
          }`;
const IMAGE_TOKENS_NEW = `          } else if (contentPart.type === "image") {
            tokenCount += 4096; // ccr-image-token-estimate-v1
          } else if (contentPart.type === "tool_result") {
            if (Array.isArray(contentPart.content)) {
              contentPart.content.forEach((part) => {
                tokenCount += part.type === "image" ? 4096 : enc.encode(part.type === "text" ? part.text : JSON.stringify(part)).length;
              });
            } else tokenCount += enc.encode(typeof contentPart.content === "string" ? contentPart.content : JSON.stringify(contentPart.content)).length;
          }`;

let src = fs.readFileSync(file, "utf8");
let changed = false, missing = [];

function patch(name, mark, oldText, newText) {
  if (src.includes(mark)) return;            // 已经打过
  if (!src.includes(oldText)) { missing.push(name); return; }
  src = src.replace(oldText, newText);
  changed = true;
}

patch("effort", EFF_MARK, EFF_OLD, EFF_NEW);
patch("uncaughtException", 'console.error("Uncaught exception:", err)', UE_OLD, UE_NEW);
patch("unhandledRejection", 'console.error("Unhandled rejection at:", promise, "reason:", reason)', UR_OLD, UR_NEW);
patch("stream reader", 'e._ccrReader = Y', READER_OLD, READER_NEW);
patch("upstream cancel", '(e._ccrReader || e).cancel(o)', CANCEL_OLD, CANCEL_NEW);
patch("error handler", 't.raw.headersSent || t.raw.writableEnded', H_OLD, H_NEW);
patch("request body log", 'n.log.debug({ data: n.body, type: "request body" })', BODY_OLD, BODY_NEW);
patch("fresh connection", 'keepAliveMaxTimeout: 1', AGENT_OLD, AGENT_NEW);
patch("explicit stream", 'stream: e.stream === true, tools:', STREAM_OLD, STREAM_NEW);
patch("JSON/SSE response", SSE_MARK, src.includes(SSE_FALLBACK) ? SSE_FALLBACK : SSE_OLD, SSE_NEW);
patch("tool result images", "// ccr-tool-images-v1:", TOOL_IMAGES_OLD, TOOL_IMAGES_NEW);
patch("image token estimate", "// ccr-image-token-estimate-v1", IMAGE_TOKENS_OLD, IMAGE_TOKENS_NEW);

// 11) npm override 不能修复 CCR 内嵌的 @fastify/static 8.2.0。
//     校验原代码指纹后整段移除旧实现，改为加载锁文件中的已修复版本；未知 bundle 拒绝写入。
const staticStart = "// node_modules/.pnpm/@fastify+static@8.2.0/node_modules/@fastify/static/lib/dirList.js";
const staticEnd = "// node_modules/.pnpm/tiktoken@1.0.22/node_modules/tiktoken/tiktoken_bg.cjs";
const staticOld = "var import_static = __toESM(require_static());";
const staticNew = 'var import_static = __toESM(require("@fastify/static"));';
const staticMark = "// ccr-static-security-v1: external @fastify/static 10.1.2";
const start = src.indexOf(staticStart), end = src.indexOf(staticEnd, start);
if (start >= 0) {
  const digest = createHash("sha256").update(src.slice(start, end)).digest("hex");
  if (end < start || digest !== "b5cb1364a7a8559c43b8bd66a63ec42f4a120c77500304261efff4e468ff2b5d" || !src.includes(staticOld)) missing.push("bundled static security");
  else {
    src = (src.slice(0, start) + staticMark + "\n\n" + src.slice(end)).replace(staticOld, staticNew);
    changed = true;
  }
} else if (!src.includes(staticMark) || !src.includes(staticNew) || /require_(?:static|dirList)\b/.test(src)) missing.push("bundled static security");
try {
  const expected = path.join(__dirname, "node_modules/@fastify/static/package.json");
  const resolved = require.resolve("@fastify/static/package.json", { paths: [path.dirname(file)] });
  const pkg = JSON.parse(fs.readFileSync(expected, "utf8"));
  if (resolved !== fs.realpathSync(expected) || pkg.version !== "10.1.2") throw new Error("unexpected static dependency");
} catch { missing.push("@fastify/static 10.1.2 dependency"); }

// npm audit 不扫描 bundle：这些内嵌 CommonJS 模块也必须移除，不能留旧实现可达。
const secureModules = {
  fastify: ["5.12.7", 30, "a0daa8a2e602e73b6e593fc319e13d0564d77ad363146af2b3073410ef8f4828"],
  ajv: ["8.20.0", 85, "6f63b7ab919bde167534aaa84314fb2fad849e59a76f2ac65ff9786c952fb245"],
  "fast-uri": ["3.1.9", 3, "8b84c8c51cc1fb8e39d1ae2f2da17b1e318f825d85baa94be728d9b8884f20ca"],
  "find-my-way": ["9.10.0", 11, "ee4536c482240ab717a64d30fb870a234956aab64eea71d1c79683a41efa4c1b"],
  undici: ["7.30.1", 103, "30b189bb9f70604d5b06c2df0732b63ed43518f46496c3b0daccb761c104f079"],
  "@isaacs/brace-expansion": ["5.0.1", 1, "f4fad01984b7b902b68790c287c7b2a4d5e8270c86b203b56bc61fb3e891c537"],
  minimatch: ["11.0.3", 6, "b6911de12dc7e3b1a58b6f12afd40b7dc3994c7f4bf71937e4f76bdaab5d371d"],
  glob: ["14.0.3", 7, "fd5227611c0d6aa5a6cc1b48abfb63f4407cc21b311fb75bff10523db30e0d07"],
  "shell-quote": ["1.12.0", 3, "363b4d666eaea08096b343aaeb5c7c3d6ca6ad7e75f78573eb776cf64f93c10a"]
};
for (const [name, [version, count, digest]] of Object.entries(secureModules)) {
  try {
    const expected = path.join(__dirname, "node_modules", name, "package.json");
    const resolved = require.resolve(name + "/package.json", { paths: [path.dirname(file)] });
    if (resolved !== fs.realpathSync(expected) || JSON.parse(fs.readFileSync(expected, "utf8")).version !== version) throw new Error("version mismatch");
  } catch { missing.push(name + " " + version + " dependency"); continue; }
  const blocks = [];
  for (const match of src.matchAll(/^\/\/ node_modules\/\.pnpm\/[^/]+\/node_modules\/([^\n]+)\nvar (\w+) = __commonJS\(\{/gm)) {
    if (!match[1].startsWith(name + "/")) continue;
    const end = src.indexOf("\n});", match.index);
    if (end < 0) continue;
    blocks.push({ text: src.slice(match.index, end + 5), subpath: match[1], factory: match[2] });
  }
  const mark = "// ccr-bundled-security-v1: " + name + " " + version;
  if (!blocks.length && src.includes(mark)) continue;
  if (blocks.length !== count || createHash("sha256").update(blocks.map(block => block.text).join("")).digest("hex") !== digest) {
    missing.push("bundled security " + name);
    continue;
  }
  for (const block of blocks) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", name, "package.json"), "utf8"));
    let relative = block.subpath.slice(name.length + 1);
    // minimatch 11 不再提供这两个内部模块；旧指纹块外若仍有引用则拒绝删除。
    if (name === "minimatch" && ["dist/commonjs/ast.js", "dist/commonjs/brace-expressions.js"].includes(relative)) {
      let retained = src;
      for (const old of blocks) retained = retained.replace(old.text, "");
      if (new RegExp("\\b" + block.factory + "\\b").test(retained)) missing.push("retained reference " + block.factory);
      else src = src.replace(block.text, mark + "\n");
      continue;
    }
    if (name === "fastify") relative = relative.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    if (!fs.existsSync(path.join(__dirname, "node_modules", name, relative))) {
      missing.push("replacement subpath " + name + "/" + relative);
      continue;
    }
    const publicEntry = relative === (pkg.main || "index.js").replace(/^\.\//, "") || name === "glob" && relative === "dist/commonjs/index.js";
    const specifier = publicEntry ? JSON.stringify(name) :
      'require("node:path").join(require.resolve(' + JSON.stringify(name + "/package.json") + '), "..", ' + JSON.stringify(relative) + ')';
    src = src.replace(block.text, mark + "\nvar " + block.factory + " = () => require(" + specifier + ");");
  }
  changed = true;
}

if (missing.length) {
  console.error("[patch-ccr] 找不到目标代码：" + missing.join(", ") + " —— CCR 版本变了？需要重新对一下 dist/cli.js");
  process.exit(1);
}
if (changed) {
  // 先检查完整候选代码；校验失败不能改 cli.js，连备份/临时文件也不用创建。
  const checked = spawnSync(process.execPath, ["--check", "--input-type=commonjs"], { input: src, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (checked.error || checked.status !== 0) {
    console.error("[patch-ccr] Node 语法检查失败，未写入 cli.js：" + (checked.error?.message || checked.stderr || checked.stdout));
    process.exit(1);
  }
  const bak = file + ".orig", temp = path.join(path.dirname(file), ".cli-" + randomUUID() + ".tmp");
  try {
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(temp, src, { flag: "wx", mode });
    fs.chmodSync(temp, mode);
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    fs.renameSync(temp, file);   // 同目录原子提交，不让运行/重启读到写了一半的 bundle
  } catch (error) {
    console.error("[patch-ccr] 写入失败，未覆盖 cli.js：" + error.message);
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log("[patch-ccr] patched: " + ["effort", "uncaughtException", "unhandledRejection", "stream reader", "upstream cancel", "error handler", "request body log", "fresh connection", "explicit stream", "JSON/SSE response", "tool result images", "image token estimate", "bundled static security"].join(", "));
  process.exit(2);   // 刚打上：正在跑的实例还是旧代码，调用方应重启
}
console.log("[patch-ccr] already patched");
