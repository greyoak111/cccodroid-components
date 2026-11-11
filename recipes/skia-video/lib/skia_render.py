#!/usr/bin/env python3
"""skia_render.py — 用 Skia（libSkiaSharp.so）做视频帧渲染。

模式：
  still   渲染单个时刻为 PNG/JPEG/WebP
  frames  按场景 fps 渲染一段为 PNG 序列
  pipe    从 stdin 读 rawvideo rgba 帧、叠加场景、写到 stdout（给 ffmpeg 用）
  video   调 ffmpeg：解码 → 本渲染器逐帧绘制 → 编码（可保留音频）
  selftest 自检（不需要外部文件）
  info    打印场景摘要
  fonts   打印字体解析结果

场景格式见 README.md。所有坐标是像素，y 轴向下，与视频一致。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import re
import shutil
import subprocess
import sys

VERSION = "0.1.0"
APP = "skia-video"

# ---------------------------------------------------------------------------
# Skia C ABI（与 SkiaSharp 3.119.4 / Skia m119 对齐）
# ---------------------------------------------------------------------------

RGBA_8888 = 4
ALPHA_PREMUL = 2
TEXT_UTF8 = 0
STYLE_FILL, STYLE_STROKE, STYLE_STROKE_AND_FILL = 0, 1, 2
CAP_BUTT, CAP_ROUND, CAP_SQUARE = 0, 1, 2
JOIN_MITER, JOIN_ROUND, JOIN_BEVEL = 0, 1, 2
FILTER_LINEAR, MIPMAP_NONE = 1, 0


class SceneError(Exception):
    pass


class SkiaError(Exception):
    pass


class ImageInfo(ctypes.Structure):
    _fields_ = [
        ("colorspace", ctypes.c_void_p),
        ("width", ctypes.c_int32),
        ("height", ctypes.c_int32),
        ("colorType", ctypes.c_int32),
        ("alphaType", ctypes.c_int32),
    ]


class Rect(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_float),
        ("top", ctypes.c_float),
        ("right", ctypes.c_float),
        ("bottom", ctypes.c_float),
    ]

    @classmethod
    def ltrb(cls, l, t, r, b):
        return cls(float(l), float(t), float(r), float(b))


class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_float), ("y", ctypes.c_float)]


class CubicResampler(ctypes.Structure):
    _fields_ = [("B", ctypes.c_float), ("C", ctypes.c_float)]


class SamplingOptions(ctypes.Structure):
    # SkiaSharp 3.x 的 SKSamplingOptions 顺序：maxAniso, useCubic, cubic, filter, mipmap
    _fields_ = [
        ("fMaxAniso", ctypes.c_int32),
        ("fUseCubic", ctypes.c_bool),
        ("fCubic", CubicResampler),
        ("fFilter", ctypes.c_int32),
        ("fMipmap", ctypes.c_int32),
    ]


SAMPLING_LINEAR = SamplingOptions(1, False, CubicResampler(0.0, 0.0), FILTER_LINEAR, MIPMAP_NONE)


class FontMetrics(ctypes.Structure):
    _fields_ = [
        ("fFlags", ctypes.c_uint32),
        ("fTop", ctypes.c_float),
        ("fAscent", ctypes.c_float),
        ("fDescent", ctypes.c_float),
        ("fBottom", ctypes.c_float),
        ("fLeading", ctypes.c_float),
        ("fAvgCharWidth", ctypes.c_float),
        ("fMaxCharWidth", ctypes.c_float),
        ("fXMin", ctypes.c_float),
        ("fXMax", ctypes.c_float),
        ("fXHeight", ctypes.c_float),
        ("fCapHeight", ctypes.c_float),
        ("fUnderlineThickness", ctypes.c_float),
        ("fUnderlinePosition", ctypes.c_float),
        ("fStrikeoutThickness", ctypes.c_float),
        ("fStrikeoutPosition", ctypes.c_float),
    ]


class PngOptions(ctypes.Structure):
    _fields_ = [
        ("fFilterFlags", ctypes.c_int32),
        ("fZLibLevel", ctypes.c_int32),
        ("fComments", ctypes.c_void_p),
        ("fICCProfile", ctypes.c_void_p),
        ("fICCProfileDescription", ctypes.c_void_p),
    ]


class JpegOptions(ctypes.Structure):
    _fields_ = [
        ("fQuality", ctypes.c_int32),
        ("fDownsample", ctypes.c_int32),
        ("fAlphaOption", ctypes.c_int32),
        ("xmpMetadata", ctypes.c_void_p),
        ("fICCProfile", ctypes.c_void_p),
        ("fICCProfileDescription", ctypes.c_void_p),
    ]


class WebpOptions(ctypes.Structure):
    _fields_ = [
        ("fCompression", ctypes.c_int32),
        ("fQuality", ctypes.c_float),
        ("fICCProfile", ctypes.c_void_p),
        ("fICCProfileDescription", ctypes.c_void_p),
    ]


def _find_library(explicit=None):
    # 不写死应用路径：PREFIX 由 cccodroid/Termux 环境设置，开发时用 sys.prefix。
    prefix = os.environ.get("PREFIX") or sys.prefix
    cands = []
    if explicit:
        cands.append(explicit)
    env = os.environ.get("SKIA_RENDER_LIB")
    if env:
        cands.append(env)
    cands.append(os.path.join(prefix, "lib", "libSkiaSharp.so"))
    for c in cands:
        if c and os.path.exists(c):
            return os.path.abspath(c)
    return None


def _reexec_with_library_path(lib_dir):
    """dlopen 找依赖库时用 LD_LIBRARY_PATH；它必须在进程启动前设置，所以重启自己。"""
    if os.environ.get("SKIA_RENDER_REEXEC") == "1":
        return False
    prefix = os.environ.get("PREFIX") or sys.prefix
    libdirs = [os.path.join(prefix, "lib")]
    if lib_dir:
        libdirs.append(lib_dir)
    old = os.environ.get("LD_LIBRARY_PATH", "")
    for d in old.split(":"):
        if d and d not in libdirs:
            libdirs.append(d)
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = ":".join(libdirs)
    env["SKIA_RENDER_REEXEC"] = "1"
    os.execve(sys.executable, [sys.executable] + sys.argv, env)
    return True


class Skia:
    def __init__(self, lib_path=None):
        self.path = _find_library(lib_path)
        if not self.path:
            raise SkiaError("找不到 libSkiaSharp.so（组件没装好？可以设 SKIA_RENDER_LIB 指到它）")
        try:
            self.lib = ctypes.CDLL(self.path)
        except OSError:
            if _reexec_with_library_path(os.path.dirname(self.path)):
                raise SystemExit(0)  # 不会走到：execve 成功就换进程了
            raise
        self._bind()
        self._typefaces = {}
        self._fonts = {}
        self._images = {}
        self._paths = {}
        self._fontmgr = None
        self._default_typeface = None
        self._warned_fonts = set()

    # ---- 绑定 -------------------------------------------------------------
    def _bind(self):
        L = self.lib
        P = ctypes.c_void_p
        I = ctypes.c_int
        F = ctypes.c_float
        S = ctypes.c_size_t
        B = ctypes.c_bool
        U = ctypes.c_uint32
        CP = ctypes.c_char_p

        def bind(name, restype, *argtypes):
            fn = getattr(L, name)
            fn.restype = restype
            fn.argtypes = list(argtypes)
            return fn

        self.colortype_default = bind("sk_colortype_get_default_8888", I)

        self.surface_new_raster = bind("sk_surface_new_raster", P, ctypes.POINTER(ImageInfo), S, P)
        self.surface_new_raster_direct = bind(
            "sk_surface_new_raster_direct", P, ctypes.POINTER(ImageInfo), P, S, P, P, P
        )
        self.surface_get_canvas = bind("sk_surface_get_canvas", P, P)
        self.surface_unref = bind("sk_surface_unref", None, P)
        self.surface_peek_pixels = bind("sk_surface_peek_pixels", B, P, P)

        self.canvas_clear = bind("sk_canvas_clear", None, P, U)
        self.canvas_save = bind("sk_canvas_save", I, P)
        self.canvas_restore = bind("sk_canvas_restore", None, P)
        self.canvas_translate = bind("sk_canvas_translate", None, P, F, F)
        self.canvas_rotate_degrees = bind("sk_canvas_rotate_degrees", None, P, F)
        self.canvas_scale = bind("sk_canvas_scale", None, P, F, F)
        self.canvas_clip_rect = bind(
            "sk_canvas_clip_rect_with_operation", None, P, ctypes.POINTER(Rect), I, B
        )
        self.canvas_draw_rect = bind("sk_canvas_draw_rect", None, P, ctypes.POINTER(Rect), P)
        self.canvas_draw_round_rect = bind(
            "sk_canvas_draw_round_rect", None, P, ctypes.POINTER(Rect), F, F, P
        )
        self.canvas_draw_oval = bind("sk_canvas_draw_oval", None, P, ctypes.POINTER(Rect), P)
        self.canvas_draw_circle = bind("sk_canvas_draw_circle", None, P, F, F, F, P)
        self.canvas_draw_line = bind("sk_canvas_draw_line", None, P, F, F, F, F, P)
        self.canvas_draw_path = bind("sk_canvas_draw_path", None, P, P, P)
        self.canvas_draw_image_rect = bind(
            "sk_canvas_draw_image_rect", None, P, P, ctypes.POINTER(Rect), ctypes.POINTER(Rect), P, P
        )
        self.canvas_draw_simple_text = bind(
            "sk_canvas_draw_simple_text", None, P, CP, S, I, F, F, P, P
        )

        self.paint_new = bind("sk_paint_new", P)
        self.paint_delete = bind("sk_paint_delete", None, P)
        self.paint_set_color = bind("sk_paint_set_color", None, P, U)
        self.paint_set_antialias = bind("sk_paint_set_antialias", None, P, B)
        self.paint_set_style = bind("sk_paint_set_style", None, P, I)
        self.paint_set_stroke_width = bind("sk_paint_set_stroke_width", None, P, F)
        self.paint_set_stroke_cap = bind("sk_paint_set_stroke_cap", None, P, I)
        self.paint_set_stroke_join = bind("sk_paint_set_stroke_join", None, P, I)
        self.paint_set_shader = bind("sk_paint_set_shader", None, P, P)
        self.paint_set_blendmode = bind("sk_paint_set_blendmode", None, P, I)
        self.version_get_string = bind("sk_version_get_string", CP)

        self.shader_linear = bind(
            "sk_shader_new_linear_gradient",
            P,
            ctypes.POINTER(Point),
            ctypes.POINTER(U),
            ctypes.POINTER(F),
            I,
            I,
            P,
        )
        self.shader_radial = bind(
            "sk_shader_new_radial_gradient",
            P,
            ctypes.POINTER(Point),
            F,
            ctypes.POINTER(U),
            ctypes.POINTER(F),
            I,
            I,
            P,
        )
        self.shader_unref = bind("sk_shader_unref", None, P)

        self.font_new_with_values = bind("sk_font_new_with_values", P, P, F, F, F)
        self.font_delete = bind("sk_font_delete", None, P)
        self.font_measure_text = bind(
            "sk_font_measure_text", F, P, CP, S, I, ctypes.POINTER(Rect), P
        )
        self.font_get_metrics = bind("sk_font_get_metrics", F, P, ctypes.POINTER(FontMetrics))

        self.fontmgr_create_default = bind("sk_fontmgr_create_default", P)
        self.fontmgr_unref = bind("sk_fontmgr_unref", None, P)
        self.fontmgr_match_family_style = bind(
            "sk_fontmgr_match_family_style", P, P, CP, P
        )
        self.fontstyle_new = bind("sk_fontstyle_new", P, I, I, I)
        self.fontstyle_delete = bind("sk_fontstyle_delete", None, P)
        self.typeface_create_from_file = bind("sk_typeface_create_from_file", P, CP, I)
        self.typeface_unref = bind("sk_typeface_unref", None, P)
        self.typeface_get_family_name = bind("sk_typeface_get_family_name", P, P)
        self.typeface_unichar_to_glyph = bind("sk_typeface_unichar_to_glyph", ctypes.c_uint16, P, ctypes.c_int32)
        self.string_get_c_str = bind("sk_string_get_c_str", CP, P)
        self.string_get_size = bind("sk_string_get_size", S, P)

        self.data_new_from_file = bind("sk_data_new_from_file", P, CP)
        self.data_unref = bind("sk_data_unref", None, P)
        self.data_get_data = bind("sk_data_get_data", P, P)
        self.data_get_size = bind("sk_data_get_size", S, P)
        self.image_new_from_encoded = bind("sk_image_new_from_encoded", P, P)
        self.image_get_width = bind("sk_image_get_width", I, P)
        self.image_get_height = bind("sk_image_get_height", I, P)
        self.image_unref = bind("sk_image_unref", None, P)

        self.path_new = bind("sk_path_new", P)
        self.path_parse_svg = bind("sk_path_parse_svg_string", B, P, CP)
        self.path_delete = bind("sk_path_delete", None, P)

        self.pixmap_new = bind("sk_pixmap_new", P)
        self.pixmap_destructor = bind("sk_pixmap_destructor", None, P)
        self.wstream_new = bind("sk_dynamicmemorywstream_new", P)
        self.wstream_destroy = bind("sk_dynamicmemorywstream_destroy", None, P)
        self.wstream_detach_as_data = bind("sk_dynamicmemorywstream_detach_as_data", P, P)
        self.png_encode = bind("sk_pngencoder_encode", B, P, P, ctypes.POINTER(PngOptions))
        self.jpeg_encode = bind("sk_jpegencoder_encode", B, P, P, ctypes.POINTER(JpegOptions))
        self.webp_encode = bind("sk_webpencoder_encode", B, P, P, ctypes.POINTER(WebpOptions))

    # ---- 字符串 / 类型信息 ------------------------------------------------
    def _string_value(self, s):
        if not s:
            return ""
        n = self.string_get_size(s)
        p = self.string_get_c_str(s)
        if not p:
            return ""
        return p[:n].decode("utf-8", "replace")

    def _typeface_family(self, tf):
        if not tf:
            return ""
        return self._string_value(self.typeface_get_family_name(tf))

    # ---- 字体 -------------------------------------------------------------
    def font_manager(self):
        if self._fontmgr is None:
            self._fontmgr = self.fontmgr_create_default()
        return self._fontmgr

    def _default_font_file(self):
        for p in (
            "/system/fonts/NotoSansCJK-Regular.ttc",
            "/system/fonts/NotoSansCJKsc-Regular.otf",
            "/system/fonts/DroidSansFallback.ttf",
            "/system/fonts/DroidSansChinese.ttf",
            "/system/fonts/NotoSans-Regular.ttf",
        ):
            if os.path.exists(p):
                return p
        return None

    def _pick_sc_index(self, path):
        """TTC 里挑简体中文那一个 face；不是 TTC 或找不到就 0。"""
        best, best_score = 0, -1
        for i in range(12):
            tf = self.typeface_create_from_file(path.encode(), i)
            if not tf:
                break
            name = self._typeface_family(tf).lower()
            self.typeface_unref(tf)
            score = -1
            if "sc" in name.split() or " simplified" in name or "简体" in name:
                score = 10
            elif "cjk" in name:
                score = 5
            elif i == 0:
                score = 0
            if score > best_score:
                best, best_score = i, score
            if score == 10:
                return i
        return best

    def _covers(self, tf, ch):
        try:
            return self.typeface_unichar_to_glyph(tf, ord(ch)) != 0
        except Exception:
            return True

    def get_typeface(self, spec=None, weight=400, italic=False, index=None, cjk=False):
        key = (spec, weight, int(bool(italic)), index, bool(cjk))
        if key in self._typefaces:
            return self._typefaces[key]
        tf = None
        # 1) 明确给了文件路径
        if spec and (spec.endswith((".ttf", ".ttc", ".otf", ".otc")) or "/" in spec):
            path = spec
            if not os.path.isabs(path):
                path = os.path.abspath(path)
            if not os.path.exists(path):
                raise SceneError(f"字体文件不存在：{path}")
            idx = index if index is not None else self._pick_sc_index(path)
            tf = self.typeface_create_from_file(path.encode(), int(idx))
            if not tf:
                raise SceneError(f"Skia 打不开字体文件：{path}")
        else:
            # 默认字体优先用系统 CJK 字体文件：font manager 的 sans-serif
            # 常常是不带汉字的拉丁字体，画中文会变成方框。
            if not spec:
                path = self._default_font_file()
                if path:
                    idx = index if index is not None else self._pick_sc_index(path)
                    tf = self.typeface_create_from_file(path.encode(), int(idx))
                if not tf:
                    fm = self.font_manager()
                    st = self.fontstyle_new(400, 5, 0)
                    try:
                        tf = self.fontmgr_match_family_style(fm, b"sans-serif", st)
                    finally:
                        if st:
                            self.fontstyle_delete(st)
                if not tf:
                    raise SceneError("找不到默认字体（系统里没有 CJK 字体）")
            else:
                fm = self.font_manager()
                st = self.fontstyle_new(int(weight), 5, 1 if italic else 0)
                try:
                    tf = self.fontmgr_match_family_style(fm, spec.encode(), st)
                finally:
                    if st:
                        self.fontstyle_delete(st)
                if tf and (not cjk or self._covers(tf, "你")):
                    self._typefaces[key] = tf
                    return tf
                # 家族名匹配不到，或匹配到的字体不含汉字：退回系统 CJK 字体文件
                reason = "不含汉字" if tf else "不可用"
                if tf:
                    self.typeface_unref(tf)
                    tf = None
                path = self._default_font_file()
                if path:
                    idx = index if index is not None else self._pick_sc_index(path)
                    tf = self.typeface_create_from_file(path.encode(), int(idx))
                if not tf:
                    raise SceneError(f"找不到字体：{spec}（也没有系统 CJK 字体）")
                self._warn_once(f"字体 {spec!r} {reason}，已退回 {os.path.basename(path)}")
        self._typefaces[key] = tf
        return tf

    def default_typeface(self):
        if self._default_typeface is None:
            self._default_typeface = self.get_typeface(None)
        return self._default_typeface

    def get_font(self, typeface, size):
        key = (typeface, float(size))
        if key not in self._fonts:
            f = self.font_new_with_values(typeface, float(size), 1.0, 0.0)
            if not f:
                raise SkiaError("sk_font_new_with_values 返回空")
            self._fonts[key] = f
        return self._fonts[key]

    def _warn_once(self, msg):
        if msg not in self._warned_fonts:
            self._warned_fonts.add(msg)
            print(f"[{APP}] 警告：{msg}", file=sys.stderr)

    # ---- 图像 / 路径 ------------------------------------------------------
    def get_image(self, path):
        ap = os.path.abspath(path)
        try:
            st = os.stat(ap)
            key = (ap, st.st_mtime_ns, st.st_size)
        except OSError:
            raise SceneError(f"图片不存在：{ap}")
        if key in self._images:
            return self._images[key]
        data = self.data_new_from_file(ap.encode())
        if not data:
            raise SceneError(f"读不了图片：{ap}")
        try:
            img = self.image_new_from_encoded(data)
        finally:
            self.data_unref(data)
        if not img:
            raise SceneError(f"Skia 解码失败（PNG/JPEG/WebP？）：{ap}")
        item = (img, self.image_get_width(img), self.image_get_height(img))
        self._images[key] = item
        return item

    def get_path(self, d):
        if d in self._paths:
            return self._paths[d]
        p = self.path_new()
        if not p:
            raise SkiaError("sk_path_new 返回空")
        if not self.path_parse_svg(p, d.encode()):
            self.path_delete(p)
            raise SceneError(f"SVG path 解析失败：{d[:80]}")
        self._paths[d] = p
        return p

    # ---- 表面 / 绘制 ------------------------------------------------------
    def new_surface(self, w, h, buf=None):
        info = ImageInfo(None, int(w), int(h), RGBA_8888, ALPHA_PREMUL)
        if buf is None:
            return self.surface_new_raster(ctypes.byref(info), int(w) * 4, None)
        return self.surface_new_raster_direct(
            ctypes.byref(info), ctypes.addressof(buf), int(w) * 4, None, None, None
        )

    def draw_scene(self, canvas, scene, t, clear=True):
        if clear:
            self.canvas_clear(canvas, parse_color(scene.background))
        for i, layer in enumerate(scene.layers):
            if not layer.get("visible", True):
                continue
            try:
                self._draw_layer(canvas, layer, t)
            except (SceneError, SkiaError):
                raise
            except Exception as e:
                raise SceneError(f"图层 {i}（{layer.get('type')}）：{e}") from e

    def _paint(self, color, opacity=1.0, style=STYLE_FILL, stroke_width=1.0, cap=CAP_BUTT, join=JOIN_MITER, shader=None, blend=None):
        p = self.paint_new()
        if not p:
            raise SkiaError("sk_paint_new 返回空")
        self.paint_set_antialias(p, True)
        self.paint_set_style(p, style)
        if style != STYLE_FILL:
            self.paint_set_stroke_width(p, float(stroke_width))
            self.paint_set_stroke_cap(p, cap)
            self.paint_set_stroke_join(p, join)
        if blend is not None:
            self.paint_set_blendmode(p, int(blend))
        if shader:
            self.paint_set_shader(p, shader)
            self.paint_set_color(p, _argb(255, 255, 255, 255, opacity))
        else:
            self.paint_set_color(p, _with_opacity(color, opacity))
        return p

    def _make_shader(self, spec):
        stops = spec.get("stops") or []
        if len(stops) < 2:
            raise SceneError("渐变至少要两个 stops")
        n = len(stops)
        colors = (ctypes.c_uint32 * n)(*[_with_opacity(parse_color(s[1]), 1.0) for s in stops])
        pos = (ctypes.c_float * n)(*[float(s[0]) for s in stops])
        tile = {"clamp": 0, "repeat": 1, "mirror": 2, "decal": 3}.get(str(spec.get("tile", "clamp")), 0)
        kind = spec.get("type", "linear")
        if kind == "radial":
            c = spec.get("center", [0, 0])
            center = Point(float(c[0]), float(c[1]))
            return self.shader_radial(ctypes.byref(center), float(spec.get("radius", 256)), colors, pos, n, tile, None)
        p2 = (Point * 2)()
        a = spec.get("from", [0, 0])
        b = spec.get("to", [0, 256])
        p2[0] = Point(float(a[0]), float(a[1]))
        p2[1] = Point(float(b[0]), float(b[1]))
        return self.shader_linear(p2, colors, pos, n, tile, None)

    def _make_paint_spec(self, spec, opacity, style, stroke_width, cap, join, blend=None):
        shader = None
        if isinstance(spec, dict) and spec.get("stops"):
            shader = self._make_shader(spec)
            p = self._paint(None, opacity, style, stroke_width, cap, join, shader, blend)
            return p, shader
        return self._paint(parse_color(spec), opacity, style, stroke_width, cap, join, None, blend), None

    def _draw_shape(self, canvas, shape, layer, t, as_round=False, oval=False):
        opacity = _clamp(_num(layer.get("opacity", 1), t), 0.0, 1.0)
        stroke_w = _num(layer.get("strokeWidth", 1), t)
        cap = {"butt": 0, "round": 1, "square": 2}.get(str(layer.get("strokeCap", "butt")), 0)
        join = {"miter": 0, "round": 1, "bevel": 2}.get(str(layer.get("strokeJoin", "miter")), 0)
        fill = _color_at(layer.get("fill"), t)
        stroke = _color_at(layer.get("stroke"), t)
        blend = _blend_of(layer)
        rx = ry = 0.0
        if as_round:
            r = layer.get("radius", layer.get("rx", 0))
            rx = _num(r, t)
            ry = _num(layer.get("ry", r), t)

        def draw(p):
            if oval:
                self.canvas_draw_oval(canvas, ctypes.byref(shape), p)
            elif as_round and (rx or ry):
                self.canvas_draw_round_rect(canvas, ctypes.byref(shape), rx, ry, p)
            else:
                self.canvas_draw_rect(canvas, ctypes.byref(shape), p)

        if fill is not None:
            p, sh = self._make_paint_spec(fill, opacity, STYLE_FILL, stroke_w, cap, join, blend)
            try:
                draw(p)
            finally:
                self.paint_delete(p)
                if sh:
                    self.shader_unref(sh)
        if stroke is not None:
            p, sh = self._make_paint_spec(stroke, opacity, STYLE_STROKE, stroke_w, cap, join, blend)
            try:
                draw(p)
            finally:
                self.paint_delete(p)
                if sh:
                    self.shader_unref(sh)

    def _draw_layer(self, canvas, layer, t):
        typ = layer.get("type")
        save = self.canvas_save(canvas)
        try:
            clip = layer.get("clip")
            if clip:
                cr = Rect.ltrb(clip[0], clip[1], clip[0] + clip[2], clip[1] + clip[3])
                self.canvas_clip_rect(canvas, ctypes.byref(cr), 1, True)

            rot = _num(layer.get("rotation", 0), t)
            sc = layer.get("scale", 1)
            if isinstance(sc, (list, tuple)):
                sx, sy = _num(sc[0], t), _num(sc[1], t)
            else:
                sx = sy = _num(sc, t)
            if rot or sx != 1.0 or sy != 1.0:
                ox, oy = self._origin(layer, t)
                self.canvas_translate(canvas, ox, oy)
                if rot:
                    self.canvas_rotate_degrees(canvas, rot)
                if sx != 1.0 or sy != 1.0:
                    self.canvas_scale(canvas, sx, sy)
                self.canvas_translate(canvas, -ox, -oy)

            if typ == "rect":
                x, y = _num(layer.get("x", 0), t), _num(layer.get("y", 0), t)
                w, h = _num(layer.get("w", 0), t), _num(layer.get("h", 0), t)
                self._draw_shape(canvas, Rect.ltrb(x, y, x + w, y + h), layer, t, as_round=True)
            elif typ == "ellipse":
                cx, cy = _num(layer.get("cx", 0), t), _num(layer.get("cy", 0), t)
                r = layer.get("r")
                rx = _num(r if r is not None else layer.get("rx", 0), t)
                ry = _num(r if r is not None else layer.get("ry", 0), t)
                shape = Rect.ltrb(cx - rx, cy - ry, cx + rx, cy + ry)
                self._draw_shape(canvas, shape, layer, t, oval=True)
            elif typ == "circle":
                cx, cy = _num(layer.get("cx", 0), t), _num(layer.get("cy", 0), t)
                r = _num(layer.get("r", 0), t)
                shape = Rect.ltrb(cx - r, cy - r, cx + r, cy + r)
                self._draw_shape(canvas, shape, layer, t, oval=True)
            elif typ == "line":
                x1, y1 = _num(layer.get("x1", 0), t), _num(layer.get("y1", 0), t)
                x2, y2 = _num(layer.get("x2", 0), t), _num(layer.get("y2", 0), t)
                opacity = _clamp(_num(layer.get("opacity", 1), t), 0.0, 1.0)
                color = _color_at(layer.get("stroke", layer.get("fill", "#FFFFFFFF")), t)
                p, sh = self._make_paint_spec(
                    color, opacity, STYLE_STROKE,
                    _num(layer.get("strokeWidth", 1), t),
                    {"butt": 0, "round": 1, "square": 2}.get(str(layer.get("strokeCap", "butt")), 0),
                    {"miter": 0, "round": 1, "bevel": 2}.get(str(layer.get("strokeJoin", "miter")), 0),
                    _blend_of(layer),
                )
                try:
                    self.canvas_draw_line(canvas, x1, y1, x2, y2, p)
                finally:
                    self.paint_delete(p)
                    if sh:
                        self.shader_unref(sh)
            elif typ == "path":
                d = layer.get("d")
                if not d:
                    raise SceneError("path 缺少 d")
                path = self.get_path(d)
                x, y = _num(layer.get("x", 0), t), _num(layer.get("y", 0), t)
                self.canvas_save(canvas)
                try:
                    self.canvas_translate(canvas, x, y)
                    self._draw_path_paints(canvas, path, layer, t)
                finally:
                    self.canvas_restore(canvas)
            elif typ == "text":
                self._draw_text(canvas, layer, t)
            elif typ == "image":
                self._draw_image(canvas, layer, t)
            else:
                raise SceneError(f"不认识的图层类型：{typ!r}")
        finally:
            self.canvas_restore(canvas)

    def _draw_path_paints(self, canvas, path, layer, t):
        opacity = _clamp(_num(layer.get("opacity", 1), t), 0.0, 1.0)
        stroke_w = _num(layer.get("strokeWidth", 1), t)
        cap = {"butt": 0, "round": 1, "square": 2}.get(str(layer.get("strokeCap", "butt")), 0)
        join = {"miter": 0, "round": 1, "bevel": 2}.get(str(layer.get("strokeJoin", "miter")), 0)
        blend = _blend_of(layer)
        fill = _color_at(layer.get("fill"), t)
        stroke = _color_at(layer.get("stroke"), t)
        if fill is not None:
            p, sh = self._make_paint_spec(fill, opacity, STYLE_FILL, stroke_w, cap, join, blend)
            try:
                self.canvas_draw_path(canvas, path, p)
            finally:
                self.paint_delete(p)
                if sh:
                    self.shader_unref(sh)
        if stroke is not None:
            p, sh = self._make_paint_spec(stroke, opacity, STYLE_STROKE, stroke_w, cap, join, blend)
            try:
                self.canvas_draw_path(canvas, path, p)
            finally:
                self.paint_delete(p)
                if sh:
                    self.shader_unref(sh)

    def _draw_text(self, canvas, layer, t):
        text = layer.get("text", "")
        if text is None:
            return
        text = str(text)
        if not text:
            return
        size = _num(layer.get("size", layer.get("fontSize", 48)), t)
        opacity = _clamp(_num(layer.get("opacity", 1), t), 0.0, 1.0)
        weight = int(_num(layer.get("weight", 400), t))
        italic = bool(layer.get("italic", False))
        spec = layer.get("fontFile") or layer.get("font")
        index = layer.get("fontIndex")
        has_cjk = any(0x3400 <= ord(ch) <= 0x9FFF or 0xF900 <= ord(ch) <= 0xFAFF for ch in text)
        tf = self.get_typeface(spec, weight, italic, index, cjk=has_cjk)
        font = self.get_font(tf, size)
        metrics = FontMetrics()
        self.font_get_metrics(font, ctypes.byref(metrics))
        ascent, descent = float(metrics.fAscent), float(metrics.fDescent)
        line_h = _num(layer.get("lineHeight", size * 1.25), t)
        lines = text.split("\n")
        x = _num(layer.get("x", 0), t)
        y = _num(layer.get("y", 0), t)
        align = str(layer.get("align", "left")).lower()
        valign = str(layer.get("valign", "baseline")).lower()

        if valign == "top":
            base = y - ascent
        elif valign == "middle":
            block = max(0, len(lines) - 1) * line_h + (descent - ascent)
            base = y - block / 2.0 - ascent
        elif valign == "bottom":
            base = y - max(0, len(lines) - 1) * line_h - descent
        else:
            base = y

        fill = _color_at(layer.get("fill", "#FFFFFFFF"), t)
        stroke = _color_at(layer.get("stroke"), t)
        stroke_w = _num(layer.get("strokeWidth", 1), t)
        cap = {"butt": 0, "round": 1, "square": 2}.get(str(layer.get("strokeCap", "butt")), 0)
        join = {"miter": 0, "round": 1, "bevel": 2}.get(str(layer.get("strokeJoin", "miter")), 0)
        blend = _blend_of(layer)

        paints = []
        if fill is not None:
            paints.append(self._make_paint_spec(fill, opacity, STYLE_FILL, stroke_w, cap, join, blend))
        if stroke is not None:
            paints.append(self._make_paint_spec(stroke, opacity, STYLE_STROKE, stroke_w, cap, join, blend))
        try:
            for i, line in enumerate(lines):
                if not line:
                    continue
                b = line.encode("utf-8")
                width = self.font_measure_text(font, b, len(b), TEXT_UTF8, None, None)
                if align == "center":
                    xx = x - width / 2.0
                elif align == "right":
                    xx = x - width
                else:
                    xx = x
                yy = base + i * line_h
                for p, sh in paints:
                    self.canvas_draw_simple_text(canvas, b, len(b), TEXT_UTF8, xx, yy, font, p)
        finally:
            for p, sh in paints:
                self.paint_delete(p)
                if sh:
                    self.shader_unref(sh)

    def _draw_image(self, canvas, layer, t):
        src = layer.get("src")
        if not src:
            raise SceneError("image 缺少 src")
        path = src if os.path.isabs(src) else os.path.join(layer["_base_dir"], src)
        img, iw, ih = self.get_image(path)
        x, y = _num(layer.get("x", 0), t), _num(layer.get("y", 0), t)
        w = _num(layer.get("w", iw), t)
        h = _num(layer.get("h", ih), t)
        fit = str(layer.get("fit", "fill")).lower()
        opacity = _clamp(_num(layer.get("opacity", 1), t), 0.0, 1.0)

        src_rect = Rect.ltrb(0, 0, iw, ih)
        dst_rect = Rect.ltrb(x, y, x + w, y + h)
        if fit in ("contain", "cover") and iw > 0 and ih > 0:
            s = min(w / iw, h / ih) if fit == "contain" else max(w / iw, h / ih)
            dw, dh = iw * s, ih * s
            if fit == "contain":
                dst_rect = Rect.ltrb(x + (w - dw) / 2.0, y + (h - dh) / 2.0, x + (w + dw) / 2.0, y + (h + dh) / 2.0)
            else:
                vis_w, vis_h = w / s, h / s
                sx = (iw - vis_w) / 2.0
                sy = (ih - vis_h) / 2.0
                src_rect = Rect.ltrb(sx, sy, sx + vis_w, sy + vis_h)
        p = self._paint("#FFFFFFFF", opacity, STYLE_FILL, blend=_blend_of(layer))
        try:
            self.canvas_draw_image_rect(
                canvas, img, ctypes.byref(src_rect), ctypes.byref(dst_rect), ctypes.byref(SAMPLING_LINEAR), p
            )
        finally:
            self.paint_delete(p)

    def _origin(self, layer, t):
        o = layer.get("origin")
        if isinstance(o, (list, tuple)) and len(o) == 2:
            return _num(o[0], t), _num(o[1], t)
        typ = layer.get("type")
        if typ in ("rect", "image"):
            x = _num(layer.get("x", 0), t)
            y = _num(layer.get("y", 0), t)
            w = _num(layer.get("w", 0), t)
            h = _num(layer.get("h", 0), t)
            return x + w / 2.0, y + h / 2.0
        if typ in ("circle", "ellipse"):
            return _num(layer.get("cx", 0), t), _num(layer.get("cy", 0), t)
        if typ == "line":
            return (
                (_num(layer.get("x1", 0), t) + _num(layer.get("x2", 0), t)) / 2.0,
                (_num(layer.get("y1", 0), t) + _num(layer.get("y2", 0), t)) / 2.0,
            )
        return _num(layer.get("x", 0), t), _num(layer.get("y", 0), t)

    # ---- 编码 -------------------------------------------------------------
    def encode_surface(self, surface, fmt="png", quality=92):
        fmt = fmt.lower()
        pix = self.pixmap_new()
        if not pix:
            raise SkiaError("sk_pixmap_new 返回空")
        try:
            if not self.surface_peek_pixels(surface, pix):
                raise SkiaError("surface_peek_pixels 失败")
            stream = self.wstream_new()
            if not stream:
                raise SkiaError("创建内存流失败")
            data = None
            try:
                if fmt in ("png",):
                    opts = PngOptions(0, 6, None, None, None)
                    ok = self.png_encode(stream, pix, ctypes.byref(opts))
                elif fmt in ("jpg", "jpeg"):
                    opts = JpegOptions(int(quality), 0, 0, None, None, None)
                    ok = self.jpeg_encode(stream, pix, ctypes.byref(opts))
                elif fmt in ("webp",):
                    opts = WebpOptions(0, float(quality), None, None)
                    ok = self.webp_encode(stream, pix, ctypes.byref(opts))
                else:
                    raise SceneError(f"不支持的输出格式：{fmt}")
                if not ok:
                    raise SkiaError(f"{fmt} 编码失败")
                data = self.wstream_detach_as_data(stream)
            finally:
                self.wstream_destroy(stream)
            if not data:
                raise SkiaError("取编码数据失败")
            try:
                size = self.data_get_size(data)
                ptr = self.data_get_data(data)
                if not ptr or not size:
                    raise SkiaError("编码数据为空")
                return ctypes.string_at(ptr, size)
            finally:
                self.data_unref(data)
        finally:
            self.pixmap_destructor(pix)


# ---------------------------------------------------------------------------
# 颜色 / 数值
# ---------------------------------------------------------------------------

_NAMED = {
    "black": (0, 0, 0), "white": (255, 255, 255), "red": (255, 0, 0),
    "green": (0, 128, 0), "lime": (0, 255, 0), "blue": (0, 0, 255),
    "yellow": (255, 255, 0), "cyan": (0, 255, 255), "magenta": (255, 0, 255),
    "gray": (128, 128, 128), "grey": (128, 128, 128), "orange": (255, 165, 0),
    "pink": (255, 192, 203), "purple": (128, 0, 128), "transparent": (0, 0, 0, 0),
}


def _rgba(value):
    """解析成 (r,g,b,a[0..255])；int 视为 ARGB。"""
    if value is None:
        return (0, 0, 0, 0)
    if isinstance(value, int):
        return ((value >> 16) & 255, (value >> 8) & 255, value & 255, (value >> 24) & 255)
    if isinstance(value, (list, tuple)):
        out = []
        for v in value[:4]:
            out.append(float(v))
        while len(out) < 3:
            out.append(0.0)
        r, g, b = (int(round(x)) for x in out[:3])
        if len(out) == 4:
            a = out[3]
            a = int(round(a * 255)) if isinstance(a, float) and 0.0 <= a <= 1.0 else int(round(a))
        else:
            a = 255
        return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)), max(0, min(255, a)))
    s = str(value).strip()
    low = s.lower()
    if low in _NAMED:
        c = _NAMED[low]
        return (c[0], c[1], c[2], c[3] if len(c) > 3 else 255)
    if s.startswith("#"):
        h = s[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        if len(h) == 6:
            h += "ff"
        if len(h) != 8:
            raise SceneError(f"颜色格式不对：{s}")
        try:
            r, g, b, a = (int(h[i:i + 2], 16) for i in (0, 2, 4, 6))
        except ValueError:
            raise SceneError(f"颜色格式不对：{s}")
        return (r, g, b, a)
    m = _RE_RGB.match(low)
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return (r, g, b, int(round(a * 255)))
    raise SceneError(f"看不懂的颜色：{s}")


import re

_RE_RGB = re.compile(r"rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)")


def parse_color(value):
    r, g, b, a = _rgba(value)
    return _argb(r, g, b, a)


def _argb(r, g, b, a=255, mul=1.0):
    a = int(round(a * mul))
    a = max(0, min(255, a))
    return (a << 24) | (max(0, min(255, int(r))) << 16) | (max(0, min(255, int(g))) << 8) | max(0, min(255, int(b)))


def _with_opacity(color, opacity):
    if isinstance(color, int):
        r, g, b, a = _rgba(color)
    else:
        r, g, b, a = _rgba(color)
    return _argb(r, g, b, a, opacity)


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# SkBlendMode（Skia m119）
_BLEND = {
    "clear": 0, "src": 1, "dst": 2, "src-over": 3, "dst-over": 4,
    "src-in": 5, "dst-in": 6, "src-out": 7, "dst-out": 8,
    "src-atop": 9, "dst-atop": 10, "xor": 11, "plus": 12, "modulate": 13,
    "screen": 14, "overlay": 15, "darken": 16, "lighten": 17,
    "color-dodge": 18, "color-burn": 19, "hard-light": 20, "soft-light": 21,
    "difference": 22, "exclusion": 23, "multiply": 24,
    "hue": 25, "saturation": 26, "color": 27, "luminosity": 28,
}


def _blend_of(layer):
    b = layer.get("blend")
    if b is None:
        return None
    key = str(b).strip().lower().replace("_", "-")
    if key not in _BLEND:
        raise SceneError(f"不认识的 blend：{b!r}")
    return _BLEND[key]


def _color_at(v, t):
    """颜色也可以写关键帧：{"keys": [[t, "#rrggbb"], …]}。"""
    if isinstance(v, dict) and ("keys" in v or "keyframes" in v):
        return _interp(v.get("keys", v.get("keyframes")), t, v.get("ease", "linear"))
    return v


def _num(v, t=None):
    """数字或 keyframes 在 t 时刻的值。"""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dict):
        keys = v.get("keys", v.get("keyframes"))
        if keys:
            return _interp(keys, t or 0.0, v.get("ease", "linear"))
        if "v" in v:
            return _num(v["v"], t)
    raise SceneError(f"这里要数字，拿到 {v!r}")


def _ease(name, u):
    name = str(name or "linear").lower()
    u = _clamp(u, 0.0, 1.0)
    if name in ("linear", "none"):
        return u
    if name in ("in", "easein", "ease-in", "incubic"):
        return u * u * u
    if name in ("out", "easeout", "ease-out", "outcubic"):
        return 1.0 - (1.0 - u) ** 3
    if name in ("inout", "easeinout", "ease-in-out", "inoutcubic"):
        return 4 * u * u * u if u < 0.5 else 1.0 - ((-2 * u + 2) ** 3) / 2.0
    if name in ("insine", "easeinsine"):
        return 1.0 - math.cos((u * math.pi) / 2.0)
    if name in ("outsine", "easeoutsine"):
        return math.sin((u * math.pi) / 2.0)
    if name in ("inoutsine", "easeinoutsine"):
        return -(math.cos(math.pi * u) - 1.0) / 2.0
    return u


def _is_colorish(v):
    if isinstance(v, (list, tuple)) and len(v) in (3, 4):
        return all(isinstance(x, (int, float)) for x in v)
    if isinstance(v, str):
        s = v.strip().lower()
        return s.startswith("#") or s.startswith("rgb") or s in _NAMED
    return False


def _interp(keys, t, ease):
    pairs = []
    for k in keys:
        if not isinstance(k, (list, tuple)) or len(k) < 2:
            raise SceneError(f"keyframe 格式应为 [时间, 值]：{k!r}")
        pairs.append((float(k[0]), k[1]))
    pairs.sort(key=lambda x: x[0])
    if t <= pairs[0][0]:
        return pairs[0][1]
    if t >= pairs[-1][0]:
        return pairs[-1][1]
    for (t0, v0), (t1, v1) in zip(pairs, pairs[1:]):
        if t0 <= t <= t1:
            if t1 == t0:
                return v1
            u = _ease(ease, (t - t0) / (t1 - t0))
            if isinstance(v0, (int, float)) and isinstance(v1, (int, float)):
                return v0 + (v1 - v0) * u
            if _is_colorish(v0) and _is_colorish(v1):
                a = _rgba(v0)
                b = _rgba(v1)
                return _argb(*[a[i] + (b[i] - a[i]) * u for i in range(4)])
            return v1 if u >= 0.5 else v0
    return pairs[-1][1]


# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------

class Scene:
    def __init__(self, data, base_dir, path=None):
        if not isinstance(data, dict):
            raise SceneError("场景顶层必须是 JSON 对象")
        self.base_dir = os.path.abspath(base_dir)
        self.path = path
        self.name = data.get("name") or (os.path.basename(path) if path else "scene")
        self.width = int(data.get("width", 0))
        self.height = int(data.get("height", 0))
        if self.width <= 0 or self.height <= 0:
            raise SceneError("场景要有正的 width 和 height")
        self.fps = float(data.get("fps", 30))
        if self.fps <= 0:
            raise SceneError("fps 要大于 0")
        d = data.get("duration")
        self.duration = float(d) if d is not None else None
        if self.duration is not None and self.duration < 0:
            raise SceneError("duration 不能是负数")
        bg = data.get("background", "#000000FF")
        self.background = None if bg is None or str(bg).lower() in ("none", "transparent") else bg
        self.layers = data.get("layers") or []
        if not isinstance(self.layers, list):
            raise SceneError("layers 必须是数组")
        for i, layer in enumerate(self.layers):
            if not isinstance(layer, dict):
                raise SceneError(f"图层 {i} 不是对象")
            layer["_base_dir"] = self.base_dir
            if not layer.get("type"):
                raise SceneError(f"图层 {i} 缺少 type")

    def frame_count(self, start=0.0, end=None):
        if end is None:
            end = self.duration
        if end is None:
            raise SceneError("场景没有 duration；请用 --duration/--end 指定")
        return max(0, int(math.ceil((end - start) * self.fps)))


def load_scene(path):
    ap = os.path.abspath(path)
    try:
        with open(ap, encoding="utf-8") as f:
            data = json.load(f)
    except OSError as e:
        raise SceneError(f"读不了场景：{e}")
    except json.JSONDecodeError as e:
        raise SceneError(f"场景 JSON 有错：{e}")
    return Scene(data, os.path.dirname(ap), ap)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _fmt_for_path(path, explicit=None):
    if explicit:
        return explicit.lower()
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return {"jpg": "jpeg"}.get(ext, ext or "png")


def _write_file(path, data):
    if path == "-":
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def _render_still(sk, scene, t, fmt, quality):
    buf = ctypes.create_string_buffer(scene.width * scene.height * 4)
    surface = sk.new_surface(scene.width, scene.height, buf)
    if not surface:
        raise SkiaError("创建 Skia surface 失败")
    try:
        canvas = sk.surface_get_canvas(surface)
        sk.draw_scene(canvas, scene, t, clear=True)
        return sk.encode_surface(surface, fmt, quality)
    finally:
        sk.surface_unref(surface)


# ---------------------------------------------------------------------------
# 管线
# ---------------------------------------------------------------------------

def _read_exact(stream, view):
    got = 0
    n = len(view)
    while got < n:
        k = stream.readinto(view[got:])
        if not k:
            break
        got += k
    return got


def _write_all(stream, view):
    mv = memoryview(view).cast("B")
    off = 0
    while off < len(mv):
        off += stream.write(mv[off:])


def cmd_pipe(sk, args):
    scene = load_scene(args.scene)
    w, h = scene.width, scene.height
    if args.width and int(args.width) != w:
        raise SceneError(f"--width {args.width} 与场景宽 {w} 不一致")
    if args.height and int(args.height) != h:
        raise SceneError(f"--height {args.height} 与场景高 {h} 不一致")
    fps = float(args.fps or scene.fps)
    if fps <= 0:
        raise SceneError("fps 要大于 0")
    offset = float(args.time_offset or 0)

    frames = args.frames
    if frames is None:
        if args.source == "none":
            frames = scene.frame_count(0, args.duration if args.duration is not None else scene.duration)
        elif scene.duration is not None:
            frames = int(math.ceil(scene.duration * fps))
        else:
            frames = None
    if frames is not None and frames < 0:
        raise SceneError("--frames 不能是负数")

    frame_bytes = w * h * 4
    buf = ctypes.create_string_buffer(frame_bytes)
    mv = memoryview(buf).cast("B")
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    i = 0
    try:
        while frames is None or i < frames:
            if args.source == "stdin":
                got = _read_exact(stdin, mv)
                if got < frame_bytes:
                    if got == 0:
                        break
                    raise SceneError(f"输入帧不完整（{got}/{frame_bytes} 字节）")
            surface = sk.new_surface(w, h, buf)
            if not surface:
                raise SkiaError("创建 Skia surface 失败")
            try:
                canvas = sk.surface_get_canvas(surface)
                sk.draw_scene(canvas, scene, offset + i / fps, clear=(args.source == "none"))
            finally:
                sk.surface_unref(surface)
            _write_all(stdout, mv)
            i += 1
            if args.progress and i % 30 == 0:
                print(f"[{APP}] 已渲染 {i} 帧（{i / fps:.1f}s）", file=sys.stderr, flush=True)
    except BrokenPipeError:
        return 4
    finally:
        try:
            stdout.flush()
        except BrokenPipeError:
            pass
    if args.progress:
        print(f"[{APP}] 完成：{i} 帧（{i / fps:.2f}s）", file=sys.stderr, flush=True)
    return 0


# ---------------------------------------------------------------------------
# ffmpeg 编排
# ---------------------------------------------------------------------------

def _run_video(sk, args):
    scene = load_scene(args.scene)
    w, h = scene.width, scene.height
    fps = float(args.fps or scene.fps)
    if fps <= 0:
        raise SceneError("fps 要大于 0")
    if args.overwrite is False and os.path.exists(args.output):
        raise SceneError(f"输出文件已存在：{args.output}（加 --overwrite 覆盖）")
    ffmpeg = os.environ.get("SKIA_RENDER_FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        raise SkiaError("找不到 ffmpeg（工具包里的 ffmpeg 应该在 PATH 里）")
    input_path = args.input
    if input_path and not os.path.exists(input_path):
        raise SceneError(f"输入文件不存在：{input_path}")

    start = float(args.start or 0)
    if args.end is not None:
        if args.end <= start:
            raise SceneError("--end 必须大于 --start")
        duration = float(args.end) - start
    else:
        duration = float(args.duration) if args.duration is not None else scene.duration

    if not input_path and duration is None:
        raise SceneError("没有输入视频时必须给 --duration（或场景里写 duration）")
    frames = None
    if duration is not None:
        frames = max(0, int(math.ceil(duration * fps)))

    src = os.path.abspath(__file__)
    source = "stdin" if input_path else "none"
    rend = [
        sys.executable, src, "--lib", sk.path, "pipe", os.path.abspath(args.scene),
        "--source", source, "--fps", repr(fps), "--width", str(w), "--height", str(h),
        "--time-offset", repr(float(args.time_offset or 0)),
    ]
    if frames is not None:
        rend += ["--frames", str(frames)]
    if not args.quiet:
        rend += ["--progress"]

    dec = None
    if input_path:
        dec = [ffmpeg, "-hide_banner", "-loglevel", "error"]
        if start:
            dec += ["-ss", repr(start)]
        dec += ["-i", input_path]
        if duration is not None:
            dec += ["-t", repr(duration)]
        fit = args.input_fit
        if fit == "stretch":
            vf = f"fps={fps},scale={w}:{h}:flags=bicubic"
        elif fit == "cover":
            vf = f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"
        else:
            vf = (f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,"
                  f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black")
        dec += ["-an", "-sn", "-dn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]

    enc = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", repr(fps), "-i", "-"]
    audio = args.audio
    if input_path and audio != "none":
        if start:
            enc += ["-ss", repr(start)]
        enc += ["-i", input_path]
    enc += ["-map", "0:v:0"]
    if input_path and audio != "none":
        enc += ["-map", "1:a:0?"]
        enc += ["-c:a", "copy"] if audio == "copy" else ["-c:a", "aac", "-b:a", "192k"]

    codec = args.codec
    if codec.endswith("_mediacodec"):
        enc += ["-c:v", codec, "-b:v", args.bitrate or "8M"]
        enc += ["-pix_fmt", args.pix_fmt or "nv12"]
    else:
        enc += ["-c:v", codec, "-preset", args.preset, "-crf", str(args.crf)]
        enc += ["-pix_fmt", args.pix_fmt or "yuv420p"]
    if duration is not None:
        enc += ["-t", repr(duration)]
    if input_path and audio != "none":
        enc += ["-shortest"]
    if args.output.lower().endswith((".mp4", ".mov", ".m4v")):
        enc += ["-movflags", "+faststart"]
    enc += args.extra + [args.output]

    if args.verbose:
        print(f"[{APP}] decoder: {' '.join(dec) if dec else '(none)'}", file=sys.stderr)
        print(f"[{APP}] render : {' '.join(rend)}", file=sys.stderr)
        print(f"[{APP}] encoder: {' '.join(enc)}", file=sys.stderr)

    # ffmpeg 不需要我们为 libSkiaSharp 设的 LD_LIBRARY_PATH；带着它反而会让
    # MediaCodec 找不到 gralloc mapper（“gralloc-mapper is missing”），硬编直接挂。
    ff_env = os.environ.copy()
    ff_env.pop("LD_LIBRARY_PATH", None)

    dproc = subprocess.Popen(dec, stdout=subprocess.PIPE, env=ff_env) if dec else None
    try:
        rproc = subprocess.Popen(
            rend,
            stdin=dproc.stdout if dproc else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
        )
    except Exception:
        if dproc:
            dproc.kill()
        raise
    if dproc:
        dproc.stdout.close()
    eproc = subprocess.Popen(enc, stdin=rproc.stdout, env=ff_env)
    rproc.stdout.close()

    ren_rc = rproc.wait()
    enc_rc = eproc.wait()
    dec_rc = dproc.wait() if dproc else 0

    if enc_rc != 0:
        raise SkiaError(f"ffmpeg 编码失败（退出码 {enc_rc}）; 输出：{args.output}")
    if ren_rc not in (0, 4):
        raise SkiaError(f"渲染器失败（退出码 {ren_rc}）")
    if dec_rc != 0:
        raise SkiaError(f"ffmpeg 解码失败（退出码 {dec_rc}）")
    if not os.path.exists(args.output) or os.path.getsize(args.output) == 0:
        raise SkiaError("没有生成有效输出文件")
    return 0


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------

def _p_err(msg):
    print(f"[{APP}] 错误：{msg}", file=sys.stderr)


def cmd_still(sk, args):
    scene = load_scene(args.scene)
    fmt = _fmt_for_path(args.output, args.format)
    data = _render_still(sk, scene, float(args.time or 0), fmt, args.quality)
    _write_file(args.output, data)
    if args.output != "-":
        print(f"[{APP}] 写了 {args.output}（{len(data)} 字节）", file=sys.stderr)
    return 0


def _frame_name(pattern, i):
    if "%" in pattern:
        return pattern % i
    root, ext = os.path.splitext(pattern)
    return f"{root}_{i:06d}{ext or '.png'}"


def cmd_frames(sk, args):
    scene = load_scene(args.scene)
    start = float(args.start or 0)
    if args.end is not None:
        end = float(args.end)
        if end <= start:
            raise SceneError("--end 必须大于 --start")
    else:
        end = args.duration if args.duration is not None else scene.duration
    if end is None:
        raise SceneError("场景没有 duration；请用 --duration/--end 指定")
    n = max(0, int(math.ceil((end - start) * scene.fps)))
    os.makedirs(args.output, exist_ok=True)
    fmt = _fmt_for_path(args.pattern, args.format)
    for i in range(n):
        t = start + i / scene.fps
        data = _render_still(sk, scene, t, fmt, args.quality)
        name = _frame_name(args.pattern, i)
        with open(os.path.join(args.output, name), "wb") as f:
            f.write(data)
        if args.progress and (i + 1) % 30 == 0:
            print(f"[{APP}] {i + 1}/{n}", file=sys.stderr, flush=True)
    print(f"[{APP}] 写了 {n} 帧到 {args.output}", file=sys.stderr)
    return 0


def cmd_info(sk, args):
    scene = load_scene(args.scene)
    info = {
        "name": scene.name,
        "width": scene.width,
        "height": scene.height,
        "fps": scene.fps,
        "duration": scene.duration,
        "frames": scene.frame_count() if scene.duration is not None else None,
        "layers": [{"type": l.get("type"), "name": l.get("name")} for l in scene.layers],
        "typefaces": sorted(k[0] for k in sk._typefaces if k[0]),
        "library": sk.path,
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


def cmd_fonts(sk, args):
    print(f"library: {sk.path}")
    print(f"default: {sk._default_font_file() or '(none)'}")
    fm = sk.font_manager()
    if fm:
        tf = sk.get_typeface(None)
        print(f"default typeface: {sk._typeface_family(tf)!r}")
        for fam in ("sans-serif", "serif", "monospace", "hnchinese-regular"):
            try:
                t = sk.get_typeface(fam)
                print(f"{fam}: {sk._typeface_family(t)!r}")
            except Exception as e:
                print(f"{fam}: <{e}>")
    print("TTC faces of default:")
    p = sk._default_font_file()
    if p:
        for i in range(12):
            tf = sk.typeface_create_from_file(p.encode(), i)
            if not tf:
                break
            print(f"  {i}: {sk._typeface_family(tf)!r}")
            sk.typeface_unref(tf)
    return 0


def cmd_selftest(sk, args):
    data = {
        "width": 32, "height": 32, "fps": 30, "duration": 1,
        "background": "#000000FF",
        "layers": [
            {"type": "rect", "x": 0, "y": 0, "w": 32, "h": 32, "fill": "#000000FF"},
            {"type": "circle", "cx": 16, "cy": 16, "r": 10, "fill": "#FF0000FF"},
        ],
    }
    scene = Scene(data, os.getcwd())
    png = _render_still(sk, scene, 0, "png", 92)
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise SkiaError("自检失败：PNG 头不对")
    buf = ctypes.create_string_buffer(32 * 32 * 4)
    surface = sk.new_surface(32, 32, buf)
    try:
        canvas = sk.surface_get_canvas(surface)
        sk.draw_scene(canvas, scene, 0.0, clear=True)
    finally:
        sk.surface_unref(surface)
    b = memoryview(buf).cast("B")
    center = tuple(b[(16 * 32 + 16) * 4:(16 * 32 + 16) * 4 + 4])
    corner = tuple(b[0:4])
    if center[0] < 200 or center[1] > 80 or center[2] > 80 or center[3] < 250:
        raise SkiaError(f"自检失败：中心像素 {center} 不是红色")
    if corner != (0, 0, 0, 255):
        raise SkiaError(f"自检失败：角落像素 {corner} 不是黑色")
    print(f"{APP} {VERSION} selftest")
    print(f"  library: {sk.path}")
    ver = sk.version_get_string()
    ver = ver.decode("utf-8", "replace") if ver else "?"
    print(f"  skia: {ver}")
    print(f"  default colortype: {sk.colortype_default()}")
    print(f"===== 总结 ===== Skia={ver} render=PASS png=PASS")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog=APP, description="Skia 视频帧渲染器（配合 ffmpeg）")
    p.add_argument("--version", action="version", version=f"{APP} {VERSION}")
    p.add_argument("--lib", help="libSkiaSharp.so 的路径（默认自动找）")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("still", help="渲染单个时刻为图片")
    s.add_argument("scene")
    s.add_argument("-t", "--time", type=float, default=0.0)
    s.add_argument("-o", "--output", required=True)
    s.add_argument("--format", choices=["png", "jpeg", "webp"])
    s.add_argument("--quality", type=int, default=92)
    s.set_defaults(func=cmd_still)

    f = sub.add_parser("frames", help="渲染 PNG 序列")
    f.add_argument("scene")
    f.add_argument("-o", "--output", required=True, help="输出目录")
    f.add_argument("--pattern", default="frame_%06d.png")
    f.add_argument("--start", type=float, default=0.0)
    f.add_argument("--end", type=float)
    f.add_argument("--duration", type=float)
    f.add_argument("--format", choices=["png", "jpeg", "webp"])
    f.add_argument("--quality", type=int, default=92)
    f.add_argument("--progress", action="store_true")
    f.set_defaults(func=cmd_frames)

    pi = sub.add_parser("pipe", help="rawvideo rgba 帧进/帧出（给 ffmpeg 用）")
    pi.add_argument("scene")
    pi.add_argument("--source", choices=["stdin", "none"], required=True)
    pi.add_argument("--fps", type=float)
    pi.add_argument("--width", type=int)
    pi.add_argument("--height", type=int)
    pi.add_argument("--frames", type=int)
    pi.add_argument("--duration", type=float)
    pi.add_argument("--time-offset", type=float, default=0.0)
    pi.add_argument("--progress", action="store_true")
    pi.set_defaults(func=cmd_pipe)

    v = sub.add_parser("video", help="解码→渲染→编码（ffmpeg）")
    v.add_argument("scene")
    v.add_argument("-i", "--input")
    v.add_argument("-o", "--output", required=True)
    v.add_argument("--fps", type=float)
    v.add_argument("--duration", type=float)
    v.add_argument("--start", type=float)
    v.add_argument("--end", type=float)
    v.add_argument("--time-offset", type=float, default=0.0)
    v.add_argument("--input-fit", choices=["contain", "cover", "stretch"], default="contain")
    v.add_argument("--codec", default="libx264")
    v.add_argument("--crf", type=float, default=20)
    v.add_argument("--preset", default="medium")
    v.add_argument("--bitrate")
    v.add_argument("--pix-fmt")
    v.add_argument("--audio", choices=["copy", "aac", "none"], default="aac")
    v.add_argument("--overwrite", action="store_true")
    v.add_argument("--quiet", action="store_true")
    v.add_argument("--verbose", action="store_true")
    v.add_argument("--extra", nargs=argparse.REMAINDER, default=[], help="额外的 ffmpeg 参数（放最后）")
    v.set_defaults(func=lambda sk, a: _run_video(sk, a))

    inf = sub.add_parser("info", help="打印场景摘要")
    inf.add_argument("scene")
    inf.set_defaults(func=cmd_info)

    fo = sub.add_parser("fonts", help="检查字体解析")
    fo.set_defaults(func=cmd_fonts)

    st = sub.add_parser("selftest", help="自检")
    st.set_defaults(func=cmd_selftest)
    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        sk = Skia(getattr(args, "lib", None))
        return args.func(sk, args)
    except SceneError as e:
        _p_err(str(e))
        return 2
    except SkiaError as e:
        _p_err(str(e))
        return 1
    except BrokenPipeError:
        return 4
    except KeyboardInterrupt:
        return 130
    except OSError as e:
        _p_err(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
