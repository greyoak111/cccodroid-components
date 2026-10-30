// QQ 官方机器人传输层：换令牌 → 拿 WebSocket 网关 → Identify / Resume → 心跳、重连；
// 以及发消息、发文件。跟网关、文件系统无关，回调交给调用方。
//
// 依赖可注入（fetch / WebSocket / now），测试用假的顶替，不联网。
import {
  QQ_TOKEN_URL, QQ_INTENTS, qqApiBase, normalizeQQDispatch,
  messageBody, fileUploadBody, fileMessageBody,
} from "./qq.mjs";

/**
 * cfg: { appId, appSecret, sandbox?, markdown? }
 * handlers: { inbound(msg), status(state, error), event(text), log(text), tr(s) }
 * deps: { fetch, WebSocket, now, delays }
 */
export function createQQClient(cfg, handlers = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const WS = deps.WebSocket || globalThis.WebSocket;
  const now = deps.now || Date.now;
  const tr = handlers.tr || ((s) => s);
  const log = handlers.log || (() => {});
  const delays = deps.delays || [1000, 2000, 5000, 10000, 20000, 30000];

  let stopped = false, socket = null, hbTimer = null, ackTimer = null, reTimer = null;
  let seq = null, sessionId = null, attempt = 0, lastAck = 0;
  let token = "", tokenExp = 0, tokenWait = null;
  const seqs = new Map();   // msg_id → 已用的 msg_seq

  const status = (state, error) => { try { handlers.status && handlers.status(state, error || null); } catch {} };
  const event = (text) => { try { handlers.event && handlers.event(text); } catch {} };
  const base = () => qqApiBase(cfg);

  // 令牌有效期约 2 小时，提前 5 分钟换
  async function getToken(force = false) {
    if (!force && token && tokenExp > now()) return token;
    if (tokenWait) return tokenWait;
    tokenWait = (async () => {
      const res = await fetchImpl(QQ_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: String(cfg.appId), clientSecret: String(cfg.appSecret) }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.access_token) {
        const why = (j && (j.message || j.err_code || j.code)) || res.status;
        throw new Error(tr("换 QQ 令牌失败（{e}），检查 AppID / AppSecret", { e: why }));
      }
      const ttl = Math.max(60, (+j.expires_in || 7200) - 300);
      token = j.access_token; tokenExp = now() + ttl * 1000;
      return token;
    })().finally(() => { tokenWait = null; });
    return tokenWait;
  }

  async function api(method, p, body, retry = true) {
    const t = await getToken();
    const res = await fetchImpl(base() + p, {
      method,
      headers: { authorization: "QQBot " + t, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    if (res.status === 401 && retry) { token = ""; tokenExp = 0; return api(method, p, body, false); }
    if (!res.ok) {
      const e = new Error((j && (j.message || j.err_code || j.code)) || `HTTP ${res.status}`);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    return j || {};
  }

  // 同一条 msg_id 最多回 5 次，msg_seq 必须逐条加一
  function nextSeq(id) {
    const n = (seqs.get(id) || 0) + 1;
    seqs.set(id, n);
    if (seqs.size > 300) seqs.delete(seqs.keys().next().value);
    return n;
  }

  async function send(target, text, opts = {}) {
    const kind = target.kind === "group" ? "group" : "user";
    const p = kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`;
    const md = !!cfg.markdown;
    const passive = !!opts.replyTo;
    const body = messageBody({
      text, markdown: md, replyTo: opts.replyTo || "",
      msgSeq: passive ? nextSeq(String(opts.replyTo)) : 0, quoteId: opts.quoteId || "",
    });
    const post = () => api("POST", p, body);
    try {
      return await post();
    } catch (e) {
      // 带引用的消息被拒：去掉引用重发
      if (body.message_reference && (e.status === 400 || e.status === 403)) {
        log(tr("带引用的消息被拒（{e}），去掉引用重发", { e: e.message }));
        delete body.message_reference;
        try { return await post(); } catch (e4) { e = e4; }
      }
      // 没开 markdown 权限 / 内容里有 markdown 不认：退回纯文本再发一次
      if (md && (e.status === 400 || e.status === 403)) {
        log(tr("markdown 发不出去（{e}），退回纯文本", { e: e.message }));
        body.msg_type = 0; body.content = text; delete body.markdown;
        try { return await post(); } catch (e2) { e = e2; }
      }
      // 被动回复只在一个 msg_id 的 5 分钟内有效；跑得久就过期了。退回主动消息。
      if (passive && (e.status === 400 || e.status === 403 || e.status === 404)) {
        log(tr("被动回复过期，改发主动消息"));
        delete body.msg_id; delete body.msg_seq;
        return post();
      }
      throw e;
    }
  }

  /** 发本机文件：先上传拿 file_info，再发一条富媒体消息（msg_type 7）。
   *  file = { buf | data(base64), name, type } */
  async function sendFile(target, file, opts = {}) {
    const kind = target.kind === "group" ? "group" : "user";
    const p = kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}` : `/v2/users/${encodeURIComponent(target.id)}`;
    const data = file.data || (file.buf ? Buffer.from(file.buf).toString("base64") : "");
    const up = await api("POST", p + "/files", fileUploadBody({ contentType: file.type, name: file.name, data }));
    const fi = (up && (up.file_info || up.file_uuid)) || "";
    if (!fi) throw new Error(tr("上传没有返回 file_info"));
    const replyTo = opts.replyTo || "";
    return api("POST", p + "/messages", fileMessageBody(fi, { replyTo, msgSeq: replyTo ? nextSeq(String(replyTo)) : 0 }));
  }

  function cleanup() {
    if (socket) { try { socket.close(); } catch {} socket = null; }
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (ackTimer) { clearInterval(ackTimer); ackTimer = null; }
  }

  function schedule(reason) {
    if (stopped || reTimer) return;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    status("connecting", reason || null);
    log(tr("重连（{why}），{n} 秒后第 {k} 次", { why: reason || tr("断开"), n: Math.round(delay / 1000), k: attempt }));
    reTimer = setTimeout(() => { reTimer = null; connect().catch(() => {}); }, delay);
    reTimer.unref?.();
  }

  async function identify() {
    if (!socket || socket.readyState !== 1) return;
    const d = { token: "QQBot " + await getToken(), intents: QQ_INTENTS, shard: [0, 1],
      properties: { $os: "android", $browser: "cccodroid", $device: "cccodroid" } };
    socket.send(JSON.stringify(sessionId != null && seq != null
      ? { op: 6, d: { token: d.token, session_id: sessionId, seq } }
      : { op: 2, d }));
  }

  async function onMessage(raw) {
    let pl;
    try { pl = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return; }
    if (typeof pl.s === "number") seq = pl.s;
    if (pl.op === 10) {
      const interval = Math.max(5000, +(pl.d && pl.d.heartbeat_interval) || 30000);
      await identify();
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => {
        if (!socket || socket.readyState !== 1) return;
        try { socket.send(JSON.stringify({ op: 1, d: seq })); } catch {}
      }, interval);
      // 两个心跳周期没有任何回音：当成死连接，重连
      if (ackTimer) clearInterval(ackTimer);
      lastAck = now();
      ackTimer = setInterval(() => {
        if (now() - lastAck > interval * 2.5) { cleanup(); schedule("心跳超时"); }
      }, Math.max(5000, interval));
      return;
    }
    if (pl.op === 11) { lastAck = now(); return; }
    if (pl.op === 7) { cleanup(); schedule("服务器要求重连"); return; }
    if (pl.op === 9) {
      sessionId = null; seq = null;
      token = ""; tokenExp = 0;
      cleanup(); schedule("会话失效");
      return;
    }
    if (pl.op !== 0) return;
    const t = pl.t || "";
    if (t === "READY") {
      sessionId = (pl.d && pl.d.session_id) || null;
      attempt = 0;
      status("online", null);
      event(tr("已连上 QQ"));
      log(tr("已连上 QQ"));
      return;
    }
    if (t === "RESUMED") { attempt = 0; status("online", null); event(tr("连接已恢复")); return; }
    log(tr("收到事件 {t}：{d}", { t, d: JSON.stringify(pl.d || {}).slice(0, 800) }));
    const msg = normalizeQQDispatch(t, pl.d, pl.id);
    if (msg) { try { handlers.inbound && handlers.inbound(msg); } catch (e) { log(tr("处理入站消息出错：{e}", { e: e.message })); } }
  }

  async function connect() {
    if (stopped) return;
    cleanup();
    status("connecting", null);
    const gw = await api("GET", "/gateway");
    if (!gw || !gw.url) throw new Error(tr("没拿到 WebSocket 地址"));
    if (typeof WS !== "function") throw new Error(tr("这个 Node 不支持 WebSocket"));
    const ws = new WS(gw.url);
    socket = ws;
    ws.addEventListener("message", (ev) => { onMessage(ev.data).catch((e) => log(tr("事件出错：{e}", { e: e.message }))); });
    ws.addEventListener("close", (ev) => {
      if (stopped || socket !== ws) return;
      cleanup();
      schedule(`连接关闭 ${ev.code || ""}`.trim());
    });
    ws.addEventListener("error", () => {
      if (stopped || socket !== ws) return;
      schedule("连接出错");
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(tr("连接超时"))), 20000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(tr("连接失败"))); }, { once: true });
    });
  }

  return {
    async start() {
      stopped = false;
      try { await connect(); }
      catch (e) { status("error", e.message); schedule(e.message); }
    },
    async stop() {
      stopped = true;
      if (reTimer) { clearTimeout(reTimer); reTimer = null; }
      cleanup();
      status("off", null);
    },
    send,
    sendFile,
    async probe() {
      const t = await getToken();
      const gw = await api("GET", "/gateway");
      return { token: t.slice(0, 6) + "…", gateway: !!gw.url, sandbox: !!cfg.sandbox };
    },
  };
}
