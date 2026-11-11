#!/usr/bin/env python3
"""Bilibili follow-group driver — QR login + relation APIs.

login                扫码登录，cookie 存 ~/.bili_cookies.json (0600)
whoami               确认登录态，打印 mid / uname
dump --out-dir DIR   拉全部关注 -> followings.json / followings.tsv
tags                 列出现有分组
tag-create NAME      新建分组
tag-assign TAGID --mids 1,2,3 | --mids-file FILE   批量设置分组
api GET|POST PATH k=v...                            裸调接口（调试用）

要点：/x/relation/tags/addUsers 是“设置”语义，会整体替换该用户的组。
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36")
COOKIE_PATH = os.path.expanduser("~/.bili_cookies.json")
API = "https://api.bilibili.com"


def load_cookies():
    if not os.path.exists(COOKIE_PATH):
        raise SystemExit("未登录，先跑: bili.py login")
    with open(COOKIE_PATH) as f:
        return json.load(f)


def save_cookies(cookies):
    # cccodroid：一开始就以 0600 建，不留先 0644 再改的窗口
    fd = os.open(COOKIE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cookies, f)
    os.chmod(COOKIE_PATH, 0o600)


def _referer():
    try:
        mid = load_cookies().get("DedeUserID")
        if mid:
            return "https://space.bilibili.com/%s/fans/follow" % mid
    except BaseException:
        pass
    return "https://space.bilibili.com/"


# cccodroid 配方检查说明：这里的 urlopen 只调 B 站 JSON 接口（api / passport），不下载文件，没有需要核 sha256 的产物
def request(url, data=None, cookies=None, timeout=20):
    headers = {
        "User-Agent": UA,
        "Referer": _referer(),
        "Origin": "https://space.bilibili.com",
        "Accept": "application/json, text/plain, */*",
    }
    if cookies:
        headers["Cookie"] = "; ".join("%s=%s" % (k, v) for k, v in cookies.items())
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
        setcookies = r.headers.get_all("Set-Cookie") or []
    try:
        return json.loads(raw), setcookies
    except json.JSONDecodeError:
        raise SystemExit("非 JSON 响应: " + raw[:300])


def api_get(path, params=None):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    obj, _ = request(url, cookies=load_cookies())
    if obj.get("code") != 0:
        raise SystemExit(json.dumps(obj, ensure_ascii=False))
    return obj.get("data")


def api_post(path, params):
    data = dict(params or {})
    data["csrf"] = load_cookies().get("bili_jct", "")
    obj, _ = request(API + path, data=data, cookies=load_cookies())
    if obj.get("code") != 0:
        raise SystemExit(json.dumps(obj, ensure_ascii=False))
    return obj.get("data")


def cmd_login(args):
    try:
        import segno
    except ImportError:
        raise SystemExit(
            "缺少 segno，先运行: python3 -m pip install --user segno")

    gen, _ = request(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
    if gen.get("code") != 0:
        raise SystemExit(gen)
    key = gen["data"]["qrcode_key"]
    url = gen["data"]["url"]
    segno.make(url).save(args.qr_out, scale=10, border=4)
    print(json.dumps({"qr": args.qr_out, "expires_in_s": 180},
                     ensure_ascii=False), flush=True)
    print("[*] 手机 B 站 -> 扫一扫 -> 相册，选这张二维码图片；"
          "或用另一台设备扫描屏幕上的图", flush=True)

    deadline = time.time() + args.timeout
    last = object()
    while time.time() < deadline:
        poll, setcookies = request(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
            "?qrcode_key=" + urllib.parse.quote(key), cookies={})
        d = poll.get("data") or {}
        state = d.get("code")
        if state != last:
            print("[poll] code=%s %s" % (state, d.get("message", "")), flush=True)
            last = state
        if state == 0:
            cookies = {}
            for sc in setcookies:
                part = sc.split(";", 1)[0]
                if "=" in part:
                    k, v = part.split("=", 1)
                    cookies[k.strip()] = v.strip()
            qs = urllib.parse.parse_qs(
                urllib.parse.urlparse(d.get("url", "")).query)
            for k in ("SESSDATA", "bili_jct", "DedeUserID",
                      "DedeUserID__ckMd5", "sid"):
                if qs.get(k):
                    cookies[k] = qs[k][0]
            if "SESSDATA" not in cookies:
                raise SystemExit("登录成功但没拿到 SESSDATA，拿到的字段: " + ",".join(sorted(cookies)))  # cccodroid：不把 cookie 值打出来
            save_cookies(cookies)
            print(json.dumps({"ok": True,
                              "DedeUserID": cookies.get("DedeUserID")},
                             ensure_ascii=False), flush=True)
            return
        if state == 86038:
            print("QR EXPIRED —— 重新运行 login 生成新二维码", flush=True)
            return
        time.sleep(2)
    print("QR TIMEOUT —— 重新运行 login", flush=True)


def cmd_whoami(args):
    nav = api_get("/x/web-interface/nav")
    print(json.dumps({"mid": nav.get("mid"), "uname": nav.get("uname"),
                      "isLogin": nav.get("isLogin")}, ensure_ascii=False))


def cmd_dump(args):
    nav = api_get("/x/web-interface/nav")
    mid = nav["mid"]
    out = os.path.expanduser(args.out_dir)
    os.makedirs(out, exist_ok=True)

    items, pn = [], 1
    while True:
        d = api_get("/x/relation/followings",
                    {"vmid": mid, "pn": pn, "ps": 50,
                     "order": "desc", "order_type": "attention"})
        lst = d.get("list") or []
        total = d.get("total") or len(items) + len(lst)
        items.extend(lst)
        print("[followings] page %d: +%d -> %d/%d"
              % (pn, len(lst), len(items), total), flush=True)
        if not lst or len(items) >= total:
            break
        pn += 1
        time.sleep(args.sleep)

    raw = os.path.join(out, "followings.json")
    with open(raw, "w") as f:
        json.dump({"mid": mid, "total": len(items), "list": items}, f,
                  ensure_ascii=False, indent=1)
    tsv = os.path.join(out, "followings.tsv")
    with open(tsv, "w") as f:
        f.write("mid\tuname\ttag\tmtime\tsign\n")
        for it in items:
            tags = it.get("tag") or []
            tag = ",".join(str(t) for t in tags) if isinstance(tags, list) else str(tags)
            sign = (it.get("sign") or "").replace("\t", " ").replace("\n", " ")
            uname = (it.get("uname") or "").replace("\t", " ")
            f.write("%s\t%s\t%s\t%s\t%s\n"
                    % (it.get("mid"), uname, tag, it.get("mtime"), sign))
    print(json.dumps({"ok": True, "count": len(items),
                      "json": raw, "tsv": tsv}, ensure_ascii=False))


def cmd_tags(args):
    tags = api_get("/x/relation/tags")
    print(json.dumps(tags, ensure_ascii=False, indent=1))


def cmd_tag_create(args):
    d = api_post("/x/relation/tag/create", {"tag": args.name})
    print(json.dumps({"ok": True, "data": d}, ensure_ascii=False))


def cmd_tag_assign(args):
    fids = args.mids or ""
    if args.mids_file:
        with open(args.mids_file) as f:
            fids = ",".join(f.read().split())
    fids = [x for x in fids.replace(" ", "").split(",") if x]
    if not fids:
        raise SystemExit("需要 --mids 或 --mids-file")
    moved = 0
    for i in range(0, len(fids), 30):
        chunk = fids[i:i + 30]
        api_post("/x/relation/tags/addUsers",
                 {"fids": ",".join(chunk), "tagids": str(args.tagids)})
        moved += len(chunk)
        print("[set] %d/%d" % (moved, len(fids)), flush=True)
        time.sleep(0.8)
    print(json.dumps({"ok": True, "moved": moved,
                      "tagid": args.tagids}, ensure_ascii=False))


def cmd_api(args):
    kv = {}
    for a in args.pairs:
        k, _, v = a.partition("=")
        kv[k] = v
    if args.method.upper() == "POST":
        d = api_post(args.path, kv)
    else:
        d = api_get(args.path, kv)
    print(json.dumps(d, ensure_ascii=False, indent=1))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("login")
    s.add_argument("--qr-out", required=True)
    s.add_argument("--timeout", type=int, default=290)
    s.set_defaults(func=cmd_login)

    s = sub.add_parser("whoami")
    s.set_defaults(func=cmd_whoami)

    s = sub.add_parser("dump")
    s.add_argument("--out-dir", default=os.environ.get("BILI_GROUPS_DATA") or "~/.bili-groups/data")
    s.add_argument("--sleep", type=float, default=0.6)
    s.set_defaults(func=cmd_dump)

    s = sub.add_parser("tags")
    s.set_defaults(func=cmd_tags)

    s = sub.add_parser("tag-create")
    s.add_argument("name")
    s.set_defaults(func=cmd_tag_create)

    s = sub.add_parser("tag-assign")
    s.add_argument("tagids")
    s.add_argument("--mids", default="")
    s.add_argument("--mids-file", default="")
    s.set_defaults(func=cmd_tag_assign)

    s = sub.add_parser("api")
    s.add_argument("method")
    s.add_argument("path")
    s.add_argument("pairs", nargs="*")
    s.set_defaults(func=cmd_api)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
