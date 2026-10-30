// QQ 协议纯函数（recipes/qq-channel/lib/qq.mjs）：离线，不联网
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  chunkText, stripMentions, qqMd, normalizeQQDispatch, messageBody,
  fileTypeOf, fileUploadBody, fileMessageBody, qqBindUrl, qqDecryptSecret,
} from "../lib/qq.mjs";

test("chunkText：按行切、每段不超上限、内容不丢、不劈开代理对", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n "), []);
  assert.deepEqual(chunkText("短消息"), ["短消息"]);
  const long = Array.from({ length: 40 }, (_, i) => "第 " + i + " 行，" + "x".repeat(100)).join("\n");
  const parts = chunkText(long, 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500, "段落超长：" + p.length);
  assert.equal(parts.join("\n").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  const emo = "😀".repeat(600);
  const ps = chunkText(emo, 300);
  assert.equal(ps.join(""), emo);
  for (const p of ps) assert.ok(p.length <= 300);
});

test("stripMentions：去掉 @机器人 的标签，顺手把多余空格收一收", () => {
  assert.equal(stripMentions("<@!123456> 你好"), "你好");
  assert.equal(stripMentions("<@123>看下日志<@!456>"), "看下日志");
  assert.equal(stripMentions("  正常  文本 "), "正常 文本");
});

test("qqMd：反引号围栏换成波浪线，表格分隔行去掉、竖线换全角", () => {
  const out = qqMd("```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.ok(out.includes("~~~\nconst a = 1;\n~~~"));
  assert.ok(!out.includes("```"));
  assert.ok(out.includes("a ｜ b"));
  assert.ok(!out.includes("|---|"));
});

test("normalizeQQDispatch：私聊和群聊都归一成 Inbound，残缺事件丢弃", () => {
  const c2c = normalizeQQDispatch("C2C_MESSAGE_CREATE", {
    id: "m1", content: "在吗", timestamp: "1700000000000", author: { user_openid: "U1" },
  }, "ev1");
  assert.deepEqual(c2c, { kind: "user", chatId: "U1", senderId: "U1", text: "在吗", messageId: "m1", eventId: "ev1", at: 1700000000000,
    attachments: [], refIdx: "", msgIdx: "", quoted: null });

  const g = normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", {
    id: "m2", content: "<@!9> 跑个测试", timestamp: "1700000001000",
    group_openid: "G1", author: { member_openid: "M1" },
  });
  assert.equal(g.kind, "group");
  assert.equal(g.chatId, "G1");
  assert.equal(g.senderId, "M1");
  assert.equal(g.text, "跑个测试");

  assert.equal(normalizeQQDispatch("AT_MESSAGE_CREATE", { id: "x" }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", { content: "x", author: { user_openid: "U" } }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", { id: "m", content: "x" }), null);
  assert.equal(normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", { id: "m", content: "x", group_openid: "G" }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", null), null);
});

test("normalizeQQDispatch：附件字段兜底、引用索引、msg_elements 正文", () => {
  const m = normalizeQQDispatch("C2C_MESSAGE_CREATE", {
    id: "m3", content: "", timestamp: "1700000002000", author: { user_openid: "U1" },
    attachments: [{ url: "https://cdn/a.jpg", content_type: "image/jpeg", filename: "a.jpg", size: 42 },
      { file_url: "https://cdn/b.png", content_type: "image/png" }, { content_type: "image/png" }],
    message_scene: { ext: ["ref_msg_idx=REF1", "msg_idx=IDX1", "source=default"] },
  }, "ev3");
  assert.equal(m.attachments.length, 2);
  assert.deepEqual(m.attachments[0], { url: "https://cdn/a.jpg", filename: "a.jpg", contentType: "image/jpeg", size: 42 });
  assert.equal(m.attachments[1].url, "https://cdn/b.png");
  assert.equal(m.refIdx, "REF1");
  assert.equal(m.msgIdx, "IDX1");

  const q = normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", {
    id: "m5", content: "<@!9> 这条说的啥", message_type: 103,
    group_openid: "G1", author: { member_openid: "M1" },
    msg_elements: [{ msg_idx: "IDX9", content: "被引用的那句", attachments: [{ content_type: "image/jpeg", filename: "b.jpg" }] }],
  });
  assert.equal(q.refIdx, "IDX9");
  assert.ok(q.quoted && q.quoted.text.includes("被引用的那句"));
  assert.ok(q.quoted.text.includes("b.jpg"));
});

test("messageBody：markdown 放 markdown.content；被动回复带 msg_id/msg_seq；引用只在纯文本里带", () => {
  assert.deepEqual(messageBody({ text: "**粗**", markdown: true }),
    { msg_type: 2, markdown: { content: "**粗**" } });
  const passive = messageBody({ text: "hi", replyTo: "M1", msgSeq: 3 });
  assert.equal(passive.msg_id, "M1");
  assert.equal(passive.msg_seq, 3);
  assert.equal(messageBody({ text: "hi" }).msg_id, undefined);
  // markdown 下不带 message_reference（官方会拒）
  assert.equal(messageBody({ text: "hi", markdown: true, quoteId: "Q1" }).message_reference, undefined);
  assert.equal(messageBody({ text: "hi", quoteId: "Q1" }).message_reference.message_id, "Q1");
});

test("富媒体：类型映射、只有文件类型带 file_name、file_info 消息体", () => {
  assert.equal(fileTypeOf("image/png"), 1);
  assert.equal(fileTypeOf("video/mp4"), 2);
  assert.equal(fileTypeOf("audio/silk"), 3);
  assert.equal(fileTypeOf("application/pdf"), 4);
  assert.equal(fileTypeOf(""), 4);

  const img = fileUploadBody({ contentType: "image/png", name: "a.png", data: "AAA" });
  assert.equal(img.file_type, 1);
  assert.equal(img.file_name, undefined);
  assert.equal(img.file_data, "AAA");
  assert.equal(img.srv_send_msg, false);

  const doc = fileUploadBody({ contentType: "text/plain", name: "a.txt", data: "AAA" });
  assert.equal(doc.file_type, 4);
  assert.equal(doc.file_name, "a.txt");

  const msg = fileMessageBody("FI", { replyTo: "M1", msgSeq: 2 });
  assert.deepEqual(msg, { msg_type: 7, media: { file_info: "FI" }, msg_id: "M1", msg_seq: 2 });
});

test("扫码绑定：地址拼得对，AES-256-GCM 密文解得开", () => {
  assert.equal(qqBindUrl("a b", "cccodroid"),
    "https://q.qq.com/qqbot/openclaw/connect.html?task_id=a%20b&source=cccodroid&_wv=2");
  const key = crypto.randomBytes(32).toString("base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const enc = Buffer.concat([iv, c.update("s3cret", "utf8"), c.final(), c.getAuthTag()]).toString("base64");
  assert.equal(qqDecryptSecret(key, enc), "s3cret");
  assert.throws(() => qqDecryptSecret(key, "bm90LWEtc2VjcmV0"));
});
