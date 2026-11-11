#!/usr/bin/env python3
"""bili MCP server — Bilibili follow-group tools over stdio JSON-RPC.

Zero dependencies. Reuses bili.py for cookies + HTTP.
stdout carries only JSON-RPC lines; all logs go to stderr.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bili  # noqa: E402

COOKIE = os.environ.get("BILI_COOKIE") or os.path.expanduser(
    "~/.bili_cookies.json")
bili.COOKIE_PATH = COOKIE
DATA_DIR = os.environ.get("BILI_GROUPS_DATA") or os.path.expanduser("~/.bili-groups/data")  # cccodroid：脚本装在 $PREFIX/lib 下，数据另放


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def text_result(s, is_error=False):
    return {"content": [{"type": "text", "text": s}], "isError": is_error}


def tool_status(args):
    nav = bili.api_get("/x/web-interface/nav")
    return text_result(json.dumps({
        "mid": nav.get("mid"), "uname": nav.get("uname"),
        "isLogin": nav.get("isLogin")}, ensure_ascii=False))


def tool_list_groups(args):
    tags = bili.api_get("/x/relation/tags")
    return text_result(json.dumps(tags, ensure_ascii=False))


def tool_create_group(args):
    name = (args.get("name") or "").strip()
    if not name:
        return text_result("name 不能为空", True)
    d = bili.api_post("/x/relation/tag/create", {"tag": name})
    return text_result(json.dumps({"ok": True, "name": name, "data": d},
                                  ensure_ascii=False))


def tool_assign_group(args):
    fids = args.get("fids") or []
    if isinstance(fids, str):
        fids = [x for x in fids.replace(" ", "").split(",") if x]
    fids = [str(x) for x in fids]
    if not fids:
        return text_result("fids 不能为空", True)
    tagid = args.get("tagid")
    if tagid is None:
        name = args.get("group")
        tags = bili.api_get("/x/relation/tags")
        mapping = {t["name"]: t["tagid"] for t in tags}
        if name not in mapping:
            return text_result(
                "没有这个分组: %s；现有: %s" % (name, ",".join(mapping)),
                True)
        tagid = mapping[name]
    moved, failed = 0, []
    chunk_size = 30
    for i in range(0, len(fids), chunk_size):
        chunk = fids[i:i + chunk_size]
        try:
            bili.api_post("/x/relation/tags/addUsers",
                          {"fids": ",".join(chunk), "tagids": str(tagid)})
            moved += len(chunk)
        except BaseException as e:  # SystemExit / HTTPError
            failed.extend(chunk)
            log("assign failed", i, e)
        time.sleep(0.8)
    return text_result(json.dumps({"ok": not failed, "moved": moved,
                                   "failed": failed, "tagid": tagid},
                                  ensure_ascii=False))


def tool_dump_followings(args):
    nav = bili.api_get("/x/web-interface/nav")
    mid = nav["mid"]
    items, pn = [], 1
    while True:
        d = bili.api_get("/x/relation/followings",
                         {"vmid": mid, "pn": pn, "ps": 50,
                          "order": "desc", "order_type": "attention"})
        lst = d.get("list") or []
        items.extend(lst)
        total = d.get("total") or len(items) + len(lst)
        if not lst or len(items) >= total:
            break
        pn += 1
        time.sleep(0.6)
    os.makedirs(DATA_DIR, exist_ok=True)
    jp = os.path.join(DATA_DIR, "followings.json")
    tp = os.path.join(DATA_DIR, "followings.tsv")
    with open(jp, "w") as f:
        json.dump({"mid": mid, "total": len(items), "list": items}, f,
                  ensure_ascii=False)
    with open(tp, "w") as f:
        f.write("mid\tuname\ttag\tmtime\tsign\n")
        for it in items:
            tags = it.get("tag") or []
            tag = ",".join(str(t) for t in tags) if isinstance(tags, list) else str(tags)
            uname = (it.get("uname") or "").replace("\t", " ")
            sign = (it.get("sign") or "").replace("\t", " ").replace("\n", " ")
            f.write("%s\t%s\t%s\t%s\t%s\n"
                    % (it.get("mid"), uname, tag, it.get("mtime"), sign))
    return text_result(json.dumps({"count": len(items), "json": jp, "tsv": tp},
                                  ensure_ascii=False))


def tool_find_following(args):
    q = (args.get("query") or "").strip().lower()
    limit = int(args.get("limit") or 20)
    jp = os.path.join(DATA_DIR, "followings.json")
    if not os.path.exists(jp):
        return text_result("还没有关注列表缓存，先调用 bili_dump_followings", True)
    data = json.load(open(jp))
    hits = []
    for it in data.get("list") or []:
        blob = ((it.get("uname") or "") + " " + (it.get("sign") or "")).lower()
        if q in blob:
            tags = it.get("tag") or []
            hits.append({"mid": str(it["mid"]), "uname": it.get("uname"),
                         "sign": it.get("sign"), "tag": tags})
            if len(hits) >= limit:
                break
    return text_result(json.dumps({"query": q, "hits": hits},
                                  ensure_ascii=False))


def tool_user_tags(args):
    fid = str(args.get("fid") or "").strip()
    if not fid:
        return text_result("fid 不能为空", True)
    d = bili.api_get("/x/relation", {"fid": fid})
    return text_result(json.dumps({"fid": fid, "tag": d.get("tag"),
                                   "special": d.get("special"),
                                   "attribute": d.get("attribute")},
                                  ensure_ascii=False))


TOOLS = [
    {"name": "bili_status",
     "description": "检查 B 站登录态，返回当前账号 mid 与昵称。",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "bili_list_groups",
     "description": "列出当前账号的全部关注分组（tagid、名称、人数）。",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "bili_create_group",
     "description": "新建一个关注分组。",
     "inputSchema": {"type": "object", "properties": {
         "name": {"type": "string", "description": "分组名称"}},
         "required": ["name"]}},
    {"name": "bili_assign_group",
     "description": "把一批关注用户移入指定分组（按分组名或 tagid）。一次可传多个 mid，内部自动分批。",
     "inputSchema": {"type": "object", "properties": {
         "fids": {"type": "array", "items": {"type": "string"},
                  "description": "用户 mid 列表"},
         "group": {"type": "string", "description": "分组名称，如 电工电气"},
         "tagid": {"type": "integer", "description": "分组 id，与 group 二选一"}},
         "required": ["fids"]}},
    {"name": "bili_dump_followings",
     "description": "拉取全部关注列表，落盘 followings.json / followings.tsv。",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "bili_find_following",
     "description": "在本地关注列表缓存里按昵称或简介关键词搜索。",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "关键词"},
         "limit": {"type": "integer", "description": "最多返回条数，默认 20"}},
         "required": ["query"]}},
    {"name": "bili_user_tags",
     "description": "查询某个用户当前所在的分组（tag 数组）。",
     "inputSchema": {"type": "object", "properties": {
         "fid": {"type": "string", "description": "用户 mid"}},
         "required": ["fid"]}},
]

HANDLERS = {
    "bili_status": tool_status,
    "bili_list_groups": tool_list_groups,
    "bili_create_group": tool_create_group,
    "bili_assign_group": tool_assign_group,
    "bili_dump_followings": tool_dump_followings,
    "bili_find_following": tool_find_following,
    "bili_user_tags": tool_user_tags,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            send({"jsonrpc": "2.0", "id": None,
                  "error": {"code": -32700, "message": "parse error"}})
            continue
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            ver = params.get("protocolVersion") or "2024-11-05"
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": ver,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "bili", "version": "1.0.0"}}})
        elif method in ("notifications/initialized", "initialized",
                        "notifications/cancelled", "notifications/progress"):
            continue
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            fn = HANDLERS.get(name)
            if not fn:
                send({"jsonrpc": "2.0", "id": mid,
                      "error": {"code": -32602,
                                "message": "unknown tool: %s" % name}})
                continue
            try:
                result = fn(args)
            except BaseException as e:
                result = text_result("ERROR: %s" % e, True)
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        else:
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid,
                      "error": {"code": -32601,
                                "message": "method not found: %s" % method}})


if __name__ == "__main__":
    main()
