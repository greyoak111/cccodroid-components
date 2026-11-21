// QQ 传输层（recipes/qq-channel/lib/client.mjs）：假的 fetch / WebSocket，不联网
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQQClient } from "../lib/client.mjs";

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** 把请求记下来，按路由函数返回假响应 */
function fakeFetch(route) {
  const calls = [];
  const f = async (url, opt = {}) => {
    const u = String(url);
    const method = opt.method || "GET";
    const body = opt.body ? JSON.parse(opt.body) : null;
    const call = { url: u, method, body, headers: opt.headers || {} };
    calls.push(call);
    const r = (route && route(call, calls)) || { body: {} };
    const status = r.status || 200;
    const payload = r.body === undefined ? "" : JSON.stringify(r.body);
    return {
      ok: status < 400, status,
      json: async () => JSON.parse(payload || "null"),
      text: async () => payload,
    };
  };
  f.calls = calls;
  return f;
}

/** 最简 WebSocket：连上后异步触发 open，send 记录解析后的载荷 */
class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.ls = {};
    FakeWS.last = this;
    setTimeout(() => {
      if (this.readyState === 0) { this.readyState = 1; this.fire("open", {}); }
    }, 0);
  }
  addEventListener(t, fn, opts = {}) {
    (this.ls[t] ||= []).push({ fn, once: !!(opts && opts.once) });
  }
  fire(t, ev) {
    const arr = this.ls[t] || [];
    this.ls[t] = arr.filter((x) => !x.once);
    for (const x of arr) x.fn(ev);
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  find(op) { return this.sent.find((x) => x.op === op); }
}

const cfg = { appId: "100", appSecret: "sec" };

test("连上网关后按 op10 发 Identify（intents 只订群和私聊），READY 置为 online", async () => {
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK", expires_in: 7200 } };
    if (c.url.endsWith("/gateway")) return { body: { url: "wss://gw.test" } };
    return { body: {} };
  });
  const states = [];
  const inbound = [];
  const c = createQQClient(cfg, { status: (s) => states.push(s), inbound: (m) => inbound.push(m) },
    { fetch: fetchImpl, WebSocket: FakeWS, delays: [10] });
  await c.start();
  const ws = FakeWS.last;
  assert.equal(ws.url, "wss://gw.test");

  ws.fire("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
  await tick();
  const ident = ws.find(2);
  assert.ok(ident, "没发 Identify");
  assert.equal(ident.d.token, "QQBot TOK");
  assert.equal(ident.d.intents, 1 << 25);
  assert.deepEqual(ident.d.shard, [0, 1]);

  ws.fire("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "S1" } }) });
  await tick();
  assert.ok(states.includes("online"), "READY 后状态没变成 online");

  ws.fire("message", { data: JSON.stringify({ op: 0, s: 2, t: "C2C_MESSAGE_CREATE", id: "E1",
    d: { id: "M1", content: "<@!9> 你好", timestamp: "1700000000000", author: { user_openid: "U1" } } }) });
  await tick();
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].text, "你好");
  assert.equal(inbound[0].chatId, "U1");
  await c.stop();
  assert.equal(states[states.length - 1], "off");
});

test("被要求重连（op7）后按退避重连；有会话时走 Resume（op6）", async () => {
  let gw = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/gateway")) return { body: { url: "wss://gw" + ++gw } };
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS, delays: [10] });
  await c.start();
  const ws1 = FakeWS.last;
  ws1.fire("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }) });
  ws1.fire("message", { data: JSON.stringify({ op: 0, s: 7, t: "READY", d: { session_id: "S1" } }) });
  await tick();

  ws1.fire("message", { data: JSON.stringify({ op: 7 }) });
  await tick(150);
  const ws2 = FakeWS.last;
  assert.notEqual(ws2, ws1, "没有重连");
  assert.equal(ws2.url, "wss://gw2");

  ws2.fire("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }) });
  await tick();
  const resume = ws2.find(6);
  assert.ok(resume, "有会话却没发 Resume");
  assert.equal(resume.d.session_id, "S1");
  assert.equal(resume.d.seq, 7);
  await c.stop();
});

test("被动回复：同一个 msg_id 的 msg_seq 从 1 递增，不同 msg_id 各算各的", async () => {
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "user", id: "U1" }, "一", { replyTo: "M1" });
  await c.send({ kind: "user", id: "U1" }, "二", { replyTo: "M1" });
  await c.send({ kind: "user", id: "U2" }, "三", { replyTo: "M2" });
  const posts = fetchImpl.calls.filter((x) => x.method === "POST" && x.url.endsWith("/messages"));
  assert.deepEqual(posts.map((p) => p.body.msg_seq), [1, 2, 1]);
  assert.deepEqual(posts.map((p) => p.body.msg_id), ["M1", "M1", "M2"]);
  assert.equal(posts[0].url, "https://api.sgroup.qq.com/v2/users/U1/messages");
  assert.equal(posts[2].url, "https://api.sgroup.qq.com/v2/users/U2/messages");
  assert.equal(posts[0].headers.authorization, "QQBot TOK");
});

test("markdown 发不出去（403）时退回纯文本重发", async () => {
  let msgs = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/messages")) {
      msgs++;
      return msgs === 1 ? { status: 403, body: { message: "无权限" } } : { body: { id: "X" } };
    }
    return { body: {} };
  });
  const c = createQQClient({ ...cfg, markdown: true }, { log: () => {} }, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "group", id: "G1" }, "**粗**");
  const posts = fetchImpl.calls.filter((x) => x.method === "POST" && x.url.endsWith("/messages"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.msg_type, 2);
  assert.equal(posts[0].body.markdown.content, "**粗**");
  assert.equal(posts[1].body.msg_type, 0);
  assert.equal(posts[1].body.content, "**粗**");
  assert.equal(posts[1].body.markdown, undefined);
  assert.equal(posts[0].url, "https://api.sgroup.qq.com/v2/groups/G1/messages");
});

test("带引用的消息被拒（400）时去掉 message_reference 重发", async () => {
  let msgs = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/messages")) {
      msgs++;
      return msgs === 1 ? { status: 400, body: { message: "invalid reference" } } : { body: {} };
    }
    return { body: {} };
  });
  const c = createQQClient(cfg, { log: () => {} }, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "user", id: "U1" }, "回你", { quoteId: "Q1" });
  const posts = fetchImpl.calls.filter((x) => x.method === "POST" && x.url.endsWith("/messages"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.message_reference.message_id, "Q1");
  assert.equal(posts[1].body.message_reference, undefined);
  assert.equal(posts[1].body.content, "回你");
});

test("被动回复过期（4xx）时去掉 msg_id 改发主动消息", async () => {
  let msgs = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/messages")) {
      msgs++;
      return msgs === 1 ? { status: 404, body: { message: "msg_id expired" } } : { body: {} };
    }
    return { body: {} };
  });
  const c = createQQClient(cfg, { log: () => {} }, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "user", id: "U1" }, "hi", { replyTo: "OLDM1" });
  const posts = fetchImpl.calls.filter((x) => x.method === "POST" && x.url.endsWith("/messages"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.msg_id, "OLDM1");
  assert.equal(posts[1].body.msg_id, undefined);
  assert.equal(posts[1].body.msg_seq, undefined);
  assert.equal(posts[1].body.content, "hi");
});

test("发文件：先上传再发 msg_type 7，被动回复同样带 msg_seq", async () => {
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/files")) return { body: { file_info: "FI" } };
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.sendFile({ kind: "user", id: "U1" }, { data: "aGk=", name: "a.txt", type: "text/plain" }, { replyTo: "M1" });
  const up = fetchImpl.calls.find((x) => x.url.endsWith("/v2/users/U1/files"));
  assert.ok(up, "没上传");
  assert.deepEqual(up.body, { file_type: 4, file_data: "aGk=", srv_send_msg: false, file_name: "a.txt" });
  const msg = fetchImpl.calls.find((x) => x.url.endsWith("/v2/users/U1/messages"));
  assert.deepEqual(msg.body, { msg_type: 7, media: { file_info: "FI" }, msg_id: "M1", msg_seq: 1 });
});

test("上传拿不到 file_info 时报错，不发空消息", async () => {
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "TOK" } };
    if (c.url.endsWith("/files")) return { body: {} };
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS });
  await assert.rejects(
    c.sendFile({ kind: "group", id: "G1" }, { data: "aGk=", name: "a.txt", type: "text/plain" }),
    /file_info/);
  assert.equal(fetchImpl.calls.filter((x) => x.url.endsWith("/messages")).length, 0);
});

test("接口 401 时换新令牌重试一次", async () => {
  let tokens = 0, msgs = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "T" + ++tokens } };
    if (c.url.endsWith("/messages")) {
      msgs++;
      return msgs === 1 ? { status: 401, body: { message: "invalid token" } } : { body: {} };
    }
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "user", id: "U1" }, "hi");
  const posts = fetchImpl.calls.filter((x) => x.method === "POST" && x.url.endsWith("/messages"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers.authorization, "QQBot T1");
  assert.equal(posts[1].headers.authorization, "QQBot T2");
  assert.equal(tokens, 2);
});

test("令牌一直缓存到过期前 5 分钟，不会每条消息都换", async () => {
  let tokens = 0;
  const fetchImpl = fakeFetch((c) => {
    if (c.url.includes("getAppAccessToken")) return { body: { access_token: "T" + ++tokens, expires_in: 7200 } };
    return { body: {} };
  });
  const c = createQQClient(cfg, {}, { fetch: fetchImpl, WebSocket: FakeWS });
  await c.send({ kind: "user", id: "U1" }, "a");
  await c.send({ kind: "user", id: "U1" }, "b");
  assert.equal(tokens, 1);
});
