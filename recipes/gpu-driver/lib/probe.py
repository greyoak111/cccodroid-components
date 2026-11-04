#!/usr/bin/env python3
"""cccodroid gpu-driver 组件探针（自检用）。

用法:
  probe.py vk-sys               厂商 Vulkan（/system loader，默认驱动）
  probe.py vk-icd <json>        指定 ICD json（$PREFIX Khronos loader；Turnip 用）
  probe.py egl-sys              厂商 GLES（系统 libEGL/libGLESv2）
  probe.py mesa-egl             Mesa EGL（$PREFIX；配合 EGL_PLATFORM / GALLIUM_DRIVER / VK_DRIVER_FILES）
  probe.py render [mesa|sys]    渲染自测：建 FBO、清屏、读回像素校验（默认 mesa）
  probe.py opencl               $PREFIX 的 libOpenCL.so（枚举 + 向量加自测）
"""
import ctypes
import os
import struct
import sys
from ctypes import (CDLL, CFUNCTYPE, POINTER, byref, c_char_p, c_float, c_int,
                    c_size_t, c_uint, c_uint32, c_uint64, c_void_p,
                    create_string_buffer, sizeof)

PREFIX = os.environ.get("PREFIX", "/data/user/0/cc.codroid/files/usr")
PREFIX_VK_LOADER = os.path.join(PREFIX, "lib", "libvulkan.so.1")
SYSTEM_VK_LOADER = "/system/lib64/libvulkan.so"
SYSTEM_EGL = "/system/lib64/libEGL.so"
SYSTEM_GLES = "/system/lib64/libGLESv2.so"
PREFIX_EGL = os.path.join(PREFIX, "lib", "libEGL.so")
PREFIX_GLES = os.path.join(PREFIX, "lib", "libGLESv2.so")
EGL_NONE = 0x3038


def hdr(s):
    print("== %s ==" % s, flush=True)


# ---------------------------------------------------------------- OpenCL
def cl_str(fn, handle, param):
    sz = c_size_t(0)
    fn(handle, param, 0, None, byref(sz))
    if sz.value == 0:
        return "<empty>"
    buf = create_string_buffer(sz.value)
    fn(handle, param, sz.value, buf, byref(sz))
    return buf.value.decode("utf-8", "replace")


def probe_opencl(path=None):
    """跑通向量加才算 OpenCL 可用：没有平台、没有设备、kernel 编不过都返回 False（gpu-info 总结行看退出码）"""
    path = path or os.path.join(PREFIX, "lib", "libOpenCL.so")
    hdr("OpenCL: " + path)
    try:
        cl = CDLL(path)
    except OSError as e:
        print("dlopen 失败:", e)
        return False
    print("dlopen OK")

    cl.clGetPlatformIDs.restype = c_int
    cl.clGetPlatformIDs.argtypes = [c_uint, POINTER(c_void_p), POINTER(c_uint)]
    n = c_uint(0)
    if cl.clGetPlatformIDs(0, None, byref(n)) != 0 or n.value == 0:
        print("没有平台（ocl-icd 且无 ICD？）")
        return False
    plats = (c_void_p * n.value)()
    cl.clGetPlatformIDs(n.value, plats, None)

    cl.clGetPlatformInfo.restype = c_int
    cl.clGetPlatformInfo.argtypes = [c_void_p, c_uint, c_size_t, c_void_p, POINTER(c_size_t)]
    for i, p in enumerate(plats):
        print("  platform[%d]: %s | %s" % (i, cl_str(cl.clGetPlatformInfo, p, 0x0902),
                                           cl_str(cl.clGetPlatformInfo, p, 0x0903)))

    cl.clGetDeviceIDs.restype = c_int
    cl.clGetDeviceIDs.argtypes = [c_void_p, c_uint64, c_uint, POINTER(c_void_p), POINTER(c_uint)]
    dn = c_uint(0)
    if cl.clGetDeviceIDs(plats[0], 0xFFFFFFFF, 0, None, byref(dn)) != 0 or dn.value == 0:
        print("没有设备")
        return False
    devs = (c_void_p * dn.value)()
    cl.clGetDeviceIDs(plats[0], 0xFFFFFFFF, dn.value, devs, None)

    cl.clGetDeviceInfo.restype = c_int
    cl.clGetDeviceInfo.argtypes = [c_void_p, c_uint, c_size_t, c_void_p, POINTER(c_size_t)]
    d = devs[0]
    print("  device :", cl_str(cl.clGetDeviceInfo, d, 0x102B),
          "|", cl_str(cl.clGetDeviceInfo, d, 0x102F))
    cu, sz = c_uint(0), c_size_t(0)
    cl.clGetDeviceInfo(d, 0x1002, 4, byref(cu), byref(sz))
    gm = c_uint64(0)
    cl.clGetDeviceInfo(d, 0x101F, 8, byref(gm), byref(sz))
    print("  CU: %d, global mem: %.1f GiB" % (cu.value, gm.value / 2 ** 30))

    # 向量加自测
    N = 4096
    a = (c_float * N)(*[float(i) for i in range(N)])
    b = (c_float * N)(*[float(2 * i) for i in range(N)])
    out = (c_float * N)()
    err = c_int(0)

    cl.clCreateContext.restype = c_void_p
    cl.clCreateContext.argtypes = [c_void_p, c_uint, POINTER(c_void_p), c_void_p, c_void_p, POINTER(c_int)]
    ctx = cl.clCreateContext(None, 1, devs, None, None, byref(err))
    cl.clCreateCommandQueue.restype = c_void_p
    cl.clCreateCommandQueue.argtypes = [c_void_p, c_void_p, c_uint64, POINTER(c_int)]
    q = cl.clCreateCommandQueue(ctx, d, 0, byref(err))
    cl.clCreateBuffer.restype = c_void_p
    cl.clCreateBuffer.argtypes = [c_void_p, c_uint64, c_size_t, c_void_p, POINTER(c_int)]
    mb = c_size_t(N * 4)
    ma = cl.clCreateBuffer(ctx, 4 | 32, mb, ctypes.cast(a, c_void_p), byref(err))
    mbb = cl.clCreateBuffer(ctx, 4 | 32, mb, ctypes.cast(b, c_void_p), byref(err))
    mc = cl.clCreateBuffer(ctx, 2, mb, None, byref(err))
    if not (ctx and q and ma and mbb and mc):
        print("  buffer/context 创建失败 err=%d" % err.value)
        return False
    src = (b"__kernel void vadd(__global const float*a,__global const float*b,"
           b"__global float*c,unsigned int n){int i=get_global_id(0);if(i<n)c[i]=a[i]+b[i];}\n")
    cl.clCreateProgramWithSource.restype = c_void_p
    cl.clCreateProgramWithSource.argtypes = [c_void_p, c_uint, POINTER(c_char_p), POINTER(c_size_t), POINTER(c_int)]
    sp, ln = c_char_p(src), c_size_t(len(src))
    prog = cl.clCreateProgramWithSource(ctx, 1, byref(sp), byref(ln), byref(err))
    cl.clBuildProgram.argtypes = [c_void_p, c_uint, POINTER(c_void_p), c_char_p, c_void_p, c_void_p]
    if cl.clBuildProgram(prog, 1, devs, None, None, None) != 0:
        print("  kernel 编译失败")
        return False
    cl.clCreateKernel.restype = c_void_p
    cl.clCreateKernel.argtypes = [c_void_p, c_char_p, POINTER(c_int)]
    k = cl.clCreateKernel(prog, b"vadd", byref(err))
    cl.clSetKernelArg.argtypes = [c_void_p, c_uint, c_size_t, c_void_p]
    for idx, mem in enumerate((ma, mbb, mc)):
        arg = c_void_p(mem)
        cl.clSetKernelArg(k, idx, sizeof(c_void_p), byref(arg))
    narg = c_uint(N)
    cl.clSetKernelArg(k, 3, 4, byref(narg))
    cl.clEnqueueNDRangeKernel.argtypes = [c_void_p, c_void_p, c_uint, POINTER(c_size_t),
                                          POINTER(c_size_t), POINTER(c_size_t), c_uint, c_void_p, c_void_p]
    gws = c_size_t(N)
    cl.clEnqueueNDRangeKernel(q, k, 1, None, byref(gws), None, 0, None, None)
    cl.clEnqueueReadBuffer.argtypes = [c_void_p, c_void_p, c_uint, c_size_t, c_size_t,
                                       c_void_p, c_uint, c_void_p, c_void_p]
    cl.clEnqueueReadBuffer(q, mc, 1, 0, mb.value, ctypes.cast(out, c_void_p), 0, None, None)
    cl.clFinish.argtypes = [c_void_p]
    cl.clFinish(q)
    ok = all(abs(out[i] - 3 * i) < 1e-3 for i in range(N))
    print("  vector add: %s" % ("PASS" if ok else "FAIL"))
    return ok


# ---------------------------------------------------------------- Vulkan
class VkApplicationInfo(ctypes.Structure):
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("pApplicationName", c_char_p),
                ("applicationVersion", c_uint32), ("pEngineName", c_char_p),
                ("engineVersion", c_uint32), ("apiVersion", c_uint32)]


class VkInstanceCreateInfo(ctypes.Structure):
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("flags", c_uint32),
                ("pApplicationInfo", POINTER(VkApplicationInfo)), ("enabledLayerCount", c_uint32),
                ("ppEnabledLayerNames", c_void_p), ("enabledExtensionCount", c_uint32),
                ("ppEnabledExtensionNames", c_void_p)]


def _mk_instance(gipa, tag):
    p = gipa(None, b"vkCreateInstance")
    if not p:
        print(tag, "没有 vkCreateInstance")
        return None, None
    create = CFUNCTYPE(c_int, POINTER(VkInstanceCreateInfo), c_void_p, POINTER(c_void_p))(p)
    app = VkApplicationInfo(0, None, b"cccodroid-gpu-probe", 1, b"probe", 1, 0x00401000)
    ci = VkInstanceCreateInfo(1, None, 0, ctypes.pointer(app), 0, None, 0, None)
    inst = c_void_p()
    rc = create(byref(ci), None, byref(inst))
    if rc != 0:
        print(tag, "vkCreateInstance rc=%d" % rc)
        return gipa, None
    return gipa, inst


def enum_devices(gipa, inst, tag):
    p = gipa(inst, b"vkEnumeratePhysicalDevices")
    if not p:
        print(tag, "没有 vkEnumeratePhysicalDevices")
        return
    enum_pd = CFUNCTYPE(c_int, c_void_p, POINTER(c_uint32), POINTER(c_void_p))(p)
    n = c_uint32(0)
    rc = enum_pd(inst, byref(n), None)
    if rc != 0 or n.value == 0:
        print(tag, "设备数 0（rc=%d）" % rc)
        return
    devs = (c_void_p * n.value)()
    enum_pd(inst, byref(n), devs)
    gdpp = gipa(inst, b"vkGetPhysicalDeviceProperties")
    get_props = CFUNCTYPE(None, c_void_p, c_void_p)(gdpp)

    def v(x):
        return "%d.%d.%d" % (x >> 22, (x >> 12) & 0x3FF, x & 0xFFF)

    for i, dv in enumerate(devs):
        buf = create_string_buffer(1024)
        get_props(dv, buf)
        api, drv, vend, dev = struct.unpack_from("<IIII", buf.raw, 0)
        name = buf.raw[20:276].split(b"\0")[0].decode(errors="replace")
        print("%s [%d] %s | vendorID=0x%04x deviceID=0x%04x | api %s | driver %s"
              % (tag, i, name, vend, dev, v(api), v(drv)))


def _vk_enumerate(loader_path, tag):
    try:
        vk = CDLL(loader_path)
    except OSError as e:
        print(tag, "dlopen 失败:", e)
        return
    f = vk.vkGetInstanceProcAddr
    f.restype = c_void_p
    f.argtypes = [c_void_p, c_char_p]
    gipa, inst = _mk_instance(f, tag)
    if inst:
        enum_devices(gipa, inst, tag)


def probe_vk_sys():
    hdr("厂商 Vulkan（系统 loader）")
    os.environ["VK_LOADER_DEBUG"] = "error,warn"
    for k in ("VK_DRIVER_FILES", "VK_ICD_FILENAMES"):
        os.environ.pop(k, None)
    _vk_enumerate(SYSTEM_VK_LOADER, "[vendor]")


def probe_vk_icd(json_path):
    hdr("指定 ICD（$PREFIX loader）")
    print("json:", json_path)
    os.environ["VK_DRIVER_FILES"] = json_path
    os.environ["VK_ICD_FILENAMES"] = json_path
    os.environ.setdefault("VK_LOADER_DEBUG", "error,warn")
    _vk_enumerate(PREFIX_VK_LOADER, "[icd]")


# ---------------------------------------------------------------- EGL/GLES
def _egl_probe(egl_path, gles_path, tag):
    try:
        egl = CDLL(egl_path)
        gl = CDLL(gles_path)
    except OSError as e:
        print(tag, "dlopen 失败:", e)
        return
    if hasattr(egl, "eglGetPlatformDisplay"):
        egl.eglGetPlatformDisplay.restype = c_void_p
        egl.eglGetPlatformDisplay.argtypes = [c_uint, c_void_p, c_void_p]
        dpy = egl.eglGetPlatformDisplay(0x31DD, None, None)  # SURFACELESS_MESA
    else:
        dpy = None
    if not dpy:
        egl.eglGetDisplay.restype = c_void_p
        egl.eglGetDisplay.argtypes = [c_void_p]
        dpy = egl.eglGetDisplay(None)
    if not dpy:
        print(tag, "eglGetDisplay 失败")
        return
    maj, mi = c_int(0), c_int(0)
    egl.eglInitialize.restype = c_uint
    egl.eglInitialize.argtypes = [c_void_p, POINTER(c_int), POINTER(c_int)]
    if not egl.eglInitialize(c_void_p(dpy), byref(maj), byref(mi)):
        print(tag, "eglInitialize 失败")
        return
    egl.eglChooseConfig.restype = c_uint
    egl.eglChooseConfig.argtypes = [c_void_p, POINTER(c_int), POINTER(c_void_p), c_int, POINTER(c_int)]
    egl.eglCreateContext.restype = c_void_p
    egl.eglCreateContext.argtypes = [c_void_p, c_void_p, c_void_p, POINTER(c_int)]
    egl.eglMakeCurrent.restype = c_uint
    egl.eglMakeCurrent.argtypes = [c_void_p, c_void_p, c_void_p, c_void_p]
    egl.eglGetProcAddress.restype = c_void_p
    egl.eglGetProcAddress.argtypes = [c_char_p]

    cfg, n = c_void_p(), c_int(0)
    attribs = (c_int * 5)(0x3033, 0x0001, 0x3040, 0x0004, EGL_NONE)  # PBUFFER + ES2
    if not egl.eglChooseConfig(c_void_p(dpy), attribs, byref(cfg), 1, byref(n)) or n.value < 1:
        print(tag, "eglChooseConfig 失败")
        return
    ctx = egl.eglCreateContext(c_void_p(dpy), cfg, None, (c_int * 3)(0x3098, 2, EGL_NONE))
    if not ctx:
        print(tag, "eglCreateContext 失败")
        return
    egl.eglMakeCurrent(c_void_p(dpy), None, None, c_void_p(ctx))
    p = egl.eglGetProcAddress(b"glGetString")
    if not p:
        print(tag, "拿不到 glGetString")
        return
    glgetstring = CFUNCTYPE(c_char_p, c_uint)(p)
    print("%s EGL %d.%d | GL_RENDERER: %s" % (
        tag, maj.value, mi.value,
        (glgetstring(0x1F01) or b"?").decode(errors="replace")))
    print("%s GL_VERSION: %s" % (tag, (glgetstring(0x1F02) or b"?").decode(errors="replace")))


def probe_egl_sys():
    hdr("厂商 GLES（系统 EGL/GLESv2）")
    _egl_probe(SYSTEM_EGL, SYSTEM_GLES, "[vendor]")


def probe_mesa_egl():
    hdr("Mesa EGL（$PREFIX）")
    print("env: EGL_PLATFORM=%s GALLIUM_DRIVER=%s VK_DRIVER_FILES=%s" % (
        os.environ.get("EGL_PLATFORM", ""), os.environ.get("GALLIUM_DRIVER", ""),
        os.environ.get("VK_DRIVER_FILES", "")))
    _egl_probe(PREFIX_EGL, PREFIX_GLES, "[mesa]")


def probe_render(which="mesa"):
    tag = "[mesa]" if which == "mesa" else "[vendor]"
    egl_path, gles_path = ((PREFIX_EGL, PREFIX_GLES) if which == "mesa"
                           else (SYSTEM_EGL, SYSTEM_GLES))
    hdr("渲染自测（建 FBO、清屏、读回像素）%s" % tag)
    try:
        egl = CDLL(egl_path)
        CDLL(gles_path)
    except OSError as e:
        print(tag, "dlopen 失败:", e)
        return
    dpy = None
    if hasattr(egl, "eglGetPlatformDisplay"):
        egl.eglGetPlatformDisplay.restype = c_void_p
        egl.eglGetPlatformDisplay.argtypes = [c_uint, c_void_p, c_void_p]
        dpy = egl.eglGetPlatformDisplay(0x31DD, None, None)  # SURFACELESS_MESA
    if not dpy:
        egl.eglGetDisplay.restype = c_void_p
        egl.eglGetDisplay.argtypes = [c_void_p]
        dpy = egl.eglGetDisplay(None)
    if not dpy:
        print(tag, "拿不到 display")
        return
    maj, mi = c_int(0), c_int(0)
    egl.eglInitialize.restype = c_uint
    egl.eglInitialize.argtypes = [c_void_p, POINTER(c_int), POINTER(c_int)]
    if not egl.eglInitialize(c_void_p(dpy), byref(maj), byref(mi)):
        print(tag, "eglInitialize 失败")
        return
    egl.eglChooseConfig.restype = c_uint
    egl.eglChooseConfig.argtypes = [c_void_p, POINTER(c_int), POINTER(c_void_p), c_int, POINTER(c_int)]
    egl.eglCreateContext.restype = c_void_p
    egl.eglCreateContext.argtypes = [c_void_p, c_void_p, c_void_p, POINTER(c_int)]
    egl.eglMakeCurrent.restype = c_uint
    egl.eglMakeCurrent.argtypes = [c_void_p, c_void_p, c_void_p, c_void_p]
    egl.eglGetProcAddress.restype = c_void_p
    egl.eglGetProcAddress.argtypes = [c_char_p]

    cfg, n = c_void_p(), c_int(0)
    attribs = (c_int * 5)(0x3033, 0x0001, 0x3040, 0x0004, EGL_NONE)  # PBUFFER + ES2
    if not egl.eglChooseConfig(c_void_p(dpy), attribs, byref(cfg), 1, byref(n)) or n.value < 1:
        print(tag, "无可用 config")
        return
    ctx = egl.eglCreateContext(c_void_p(dpy), cfg, None, (c_int * 3)(0x3098, 2, EGL_NONE))
    if not ctx or not egl.eglMakeCurrent(c_void_p(dpy), None, None, c_void_p(ctx)):
        print(tag, "context 失败")
        return

    def proc(name, restype, *args):
        p = egl.eglGetProcAddress(name)
        if not p:
            raise RuntimeError("缺函数 %s" % name.decode())
        return CFUNCTYPE(restype, *args)(p)

    try:
        gl_gen_fbos = proc(b"glGenFramebuffers", None, c_int, POINTER(c_uint))
        gl_bind_fbo = proc(b"glBindFramebuffer", None, c_uint, c_uint)
        gl_gen_tex = proc(b"glGenTextures", None, c_int, POINTER(c_uint))
        gl_bind_tex = proc(b"glBindTexture", None, c_uint, c_uint)
        gl_tex_image = proc(b"glTexImage2D", None, c_uint, c_int, c_int, c_int, c_int,
                            c_int, c_uint, c_uint, c_void_p)
        gl_tex_param = proc(b"glTexParameteri", None, c_uint, c_uint, c_int)
        gl_fbo_tex = proc(b"glFramebufferTexture2D", None, c_uint, c_uint, c_uint, c_uint, c_int)
        gl_fbo_status = proc(b"glCheckFramebufferStatus", c_uint, c_uint)
        gl_viewport = proc(b"glViewport", None, c_int, c_int, c_int, c_int)
        gl_clear_color = proc(b"glClearColor", None, c_float, c_float, c_float, c_float)
        gl_clear = proc(b"glClear", None, c_uint)
        gl_read_pixels = proc(b"glReadPixels", None, c_int, c_int, c_int, c_int, c_uint, c_uint, c_void_p)
        gl_finish = proc(b"glFinish", None)
    except RuntimeError as e:
        print(tag, e)
        return

    GL_TEXTURE_2D, GL_RGBA, GL_UNSIGNED_BYTE = 0x0DE1, 0x1908, 0x1401
    GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_FRAMEBUFFER_COMPLETE = 0x8D40, 0x8CE0, 0x8CD5
    GL_TEXTURE_MIN_FILTER, GL_TEXTURE_MAG_FILTER, GL_LINEAR = 0x2801, 0x2800, 0x2601
    GL_COLOR_BUFFER_BIT = 0x4000

    tex, fbo = c_uint(0), c_uint(0)
    gl_gen_tex(1, byref(tex))
    gl_bind_tex(GL_TEXTURE_2D, tex.value)
    gl_tex_image(GL_TEXTURE_2D, 0, GL_RGBA, 64, 64, 0, GL_RGBA, GL_UNSIGNED_BYTE, None)
    gl_tex_param(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
    gl_tex_param(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
    gl_gen_fbos(1, byref(fbo))
    gl_bind_fbo(GL_FRAMEBUFFER, fbo.value)
    gl_fbo_tex(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex.value, 0)
    st = gl_fbo_status(GL_FRAMEBUFFER)
    if st != GL_FRAMEBUFFER_COMPLETE:
        print(tag, "FBO 不完整: 0x%x" % st)
        return
    gl_viewport(0, 0, 64, 64)
    gl_clear_color(0.25, 0.5, 0.75, 1.0)
    gl_clear(GL_COLOR_BUFFER_BIT)
    px = (ctypes.c_ubyte * 4)()
    gl_read_pixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, ctypes.cast(px, c_void_p))
    gl_finish()
    got, exp = tuple(px), (64, 128, 191, 255)
    ok = all(abs(a - b) <= 2 for a, b in zip(got, exp))
    print("%s 读回像素 %s（期望 %s）-> %s" % (tag, got, exp, "PASS" if ok else "FAIL"))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "vk-sys":
        probe_vk_sys()
    elif cmd == "vk-icd":
        probe_vk_icd(os.path.abspath(sys.argv[2]))
    elif cmd == "egl-sys":
        probe_egl_sys()
    elif cmd == "mesa-egl":
        probe_mesa_egl()
    elif cmd == "render":
        probe_render(sys.argv[2] if len(sys.argv) > 2 else "mesa")
    elif cmd == "opencl":
        sys.exit(0 if probe_opencl(sys.argv[2] if len(sys.argv) > 2 else None) else 1)
    else:
        print(__doc__)
        sys.exit(2)
