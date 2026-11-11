// QQ 官方机器人协议里与网关无关的部分：事件归一化、markdown 归一、分段、发送载荷、扫码绑定解密。
// 纯函数，不读文件、不联网、不打印；网络与重连在 client.mjs。
//
// 背景见 README.md：cccodroid 核心还没有「组件随网关常驻 / 自启 / 扩展页入口」的机制，
// 这些代码先按组件仓库的规矩放着，等机制到位再接成可安装组件。

import crypto from "node:crypto";

export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_INTENTS = 1 << 25;   // GROUP_AND_C2C_EVENT
export const qqApiBase = (cfg) => (cfg.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com");

/** 群消息里 @机器人 会留下 <@!123> / <@123>，去掉 */
export function stripMentions(s) {
  return String(s || "").replace(/<@!?\d+>/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** 按码点切分，不切断代理对；QQ 文本单条约 2000 字，留余量 */
export function chunkText(text, max = 1800) {
  const s = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  const out = [];
  let buf = "";
  for (const line of s.split("\n")) {
    const piece = line + "\n";
    if (buf && buf.length + piece.length > max) { out.push(buf.replace(/\n$/, "")); buf = ""; }
    if (piece.length > max) {
      let rest = piece;
      while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max); }
      buf = rest;
    } else buf += piece;
  }
  if (buf.trim()) out.push(buf.replace(/\n$/, ""));
  return out.filter((x) => x.trim().length > 0);
}

/** QQ 的 markdown 子集挑语法：反引号 ``` 围栏渲染是乱的，波浪线 ~~~ 围栏正常；
 *  表格不支持，竖线留着会解析错。发之前先归一化。 */
export function qqMd(s) {
  return String(s || "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => "~~~\n" + code.replace(/\n+$/, "") + "\n~~~")
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "")
    .replace(/^\|(.+)\|$/gm, (m, row) => row.split("|").map((c) => c.trim()).join(" ｜ "))
    .replace(/\n{3,}/g, "\n\n");
}

/** 引用：QQ 的入站事件不直接给被引用消息的正文，只给一个索引
 *  （message_scene.ext 里的 ref_msg_idx=REFIDX_…），要靠本地记下每条消息的 msg_idx 回查。
 *  有 msg_elements 时那个更全（带正文和附件），优先用它。 */
export function sceneRefs(d) {
  const ext = d && d.message_scene && Array.isArray(d.message_scene.ext) ? d.message_scene.ext : [];
  let refIdx = "", msgIdx = "";
  for (const item of ext) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const k = item.slice(0, eq).trim(), v = item.slice(eq + 1).trim();
    if (!v) continue;
    if (k === "msg_idx") msgIdx = v;
    else if (k === "ref_msg_idx") refIdx = v;
  }
  if (d && Number(d.message_type) === 103 && Array.isArray(d.msg_elements)) {
    const el = d.msg_elements.find((x) => x && x.msg_idx);
    if (el) refIdx = el.msg_idx;
  }
  return { refIdx, msgIdx };
}

/** msg_elements 里被引用那条的正文/附件描述 */
export function elementQuote(d) {
  const el = d && Array.isArray(d.msg_elements) ? d.msg_elements[0] : null;
  if (!el) return null;
  const parts = [];
  const text = String(el.content || "").trim();
  if (text) parts.push(text);
  for (const a of (Array.isArray(el.attachments) ? el.attachments : [])) {
    const ct = String(a && a.content_type || "").toLowerCase();
    const nm = a && a.filename ? "：" + a.filename : "";
    parts.push(ct.startsWith("image/") ? "[图片" + nm + "]" : ct.startsWith("audio/") ? "[语音]" : "[文件" + nm + "]");
  }
  const body = parts.join("\n").trim();
  return body ? { text: body } : null;
}

/** 消息里带的图片/文件。QQ 给的是 CDN 直链，调用方自己下到本机。
 *  各家版本的字段名不一样（url / file_url / download_url / media_url），都认。 */
export function attachmentsOf(d) {
  return (Array.isArray(d && d.attachments) ? d.attachments : [])
    .map((a) => ({
      url: String((a && (a.url || a.file_url || a.download_url || a.media_url)) || ""),
      filename: String((a && a.filename) || ""),
      contentType: String((a && a.content_type) || ""),
      size: Number(a && a.size) || 0,
    }))
    .filter((a) => a.url);
}

/** 把 QQ 的 dispatch 归一化成 Inbound。返回 null 表示不关心（别的类型 / 缺关键字段）。 */
export function normalizeQQDispatch(type, d, eventId) {
  if (!d || typeof d !== "object") return null;
  const text = stripMentions(String(d.content || ""));
  const id = d.id ? String(d.id) : "";
  const at = +(d.timestamp || 0) || Date.now();
  if (type === "C2C_MESSAGE_CREATE") {
    const senderId = d.author && d.author.user_openid ? String(d.author.user_openid) : "";
    if (!id || !senderId) return null;
    return { kind: "user", chatId: senderId, senderId, text: text.trim(), messageId: id, eventId: eventId || "", at,
      attachments: attachmentsOf(d), ...sceneRefs(d), quoted: elementQuote(d) };
  }
  if (type === "GROUP_AT_MESSAGE_CREATE") {
    const chatId = d.group_openid ? String(d.group_openid) : "";
    const senderId = d.author && d.author.member_openid ? String(d.author.member_openid) : "";
    if (!id || !chatId || !senderId) return null;
    return { kind: "group", chatId, senderId, text: text.trim(), messageId: id, eventId: eventId || "", at,
      attachments: attachmentsOf(d), ...sceneRefs(d), quoted: elementQuote(d) };
  }
  return null;
}

/** 一条消息的请求体。QQ 的 markdown 不是「msg_type 2 + content」：正文要放进 markdown.content 对象里，
 *  放 content 里会被当纯文本，客户端只显示原始的 ** 和 #。
 *  - replyTo / msgSeq：被动回复，同一个 msg_id 最多 5 次、msg_seq 逐条加一
 *  - quoteId：message_reference，官方只在非 markdown 模式下认 */
export function messageBody({ text, markdown = false, replyTo = "", msgSeq = 0, quoteId = "" } = {}) {
  const body = markdown ? { msg_type: 2, markdown: { content: qqMd(text) } } : { content: text, msg_type: 0 };
  if (replyTo) { body.msg_id = String(replyTo); body.msg_seq = Number(msgSeq) || 1; }
  if (quoteId && !markdown) body.message_reference = { message_id: String(quoteId), ignore_get_message_error: true };
  return body;
}

/** QQ 富媒体类型：1 图片、2 视频、3 语音、4 文件 */
export function fileTypeOf(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return 1;
  if (ct.startsWith("video/")) return 2;
  if (ct.startsWith("audio/")) return 3;
  return 4;
}

/** 上传载荷。只有「文件」类型认 file_name；data 是 base64。 */
export function fileUploadBody({ contentType, name = "", data = "" } = {}) {
  const ft = fileTypeOf(contentType);
  return { file_type: ft, file_data: String(data || ""), srv_send_msg: false, ...(ft === 4 ? { file_name: name } : {}) };
}

/** 富媒体消息体（msg_type 7），文件先经 /files 上传拿到 file_info 再发 */
export function fileMessageBody(fileInfo, { replyTo = "", msgSeq = 0 } = {}) {
  const body = { msg_type: 7, media: { file_info: String(fileInfo || "") } };
  if (replyTo) { body.msg_id = String(replyTo); body.msg_seq = Number(msgSeq) || 1; }
  return body;
}

// ── 扫码绑定（QQ 官方机器人）────────────────────────────────────────
// 腾讯的「扫码连接」接口，OpenClaw 的 @tencent-connect/qqbot-connector 走的也是这三个 POST：
//   /lite/create_bind_task  {key}      → task_id（key 是本地随机 32 字节，base64）
//   手机 QQ 扫 q.qq.com/qqbot/openclaw/connect.html?task_id=…
//   /lite/poll_bind_result  {task_id}  → status 0/1 等、2 完成、3 过期；
//                                        完成时带 bot_appid 和加密的 bot_encrypt_secret
// 密文 = base64(IV 12 | 密文 | tag 16)，用 create 时的 key 做 AES-256-GCM 解。
export const QQ_BIND_PAGE = "https://q.qq.com/qqbot/openclaw/connect.html";
export function qqBindUrl(taskId, source = "cccodroid") {
  return `${QQ_BIND_PAGE}?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source)}&_wv=2`;
}

export function qqDecryptSecret(keyB64, encB64) {
  const raw = Buffer.from(String(encB64 || ""), "base64");
  if (raw.length < 29) throw new Error("密文太短");
  const key = Buffer.from(String(keyB64 || ""), "base64");
  if (key.length !== 32) throw new Error("key 要是 32 字节（base64）");
  const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), body = raw.subarray(12, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
