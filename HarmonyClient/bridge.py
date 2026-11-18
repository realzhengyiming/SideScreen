#!/usr/bin/env python3
"""Serve the SideScreen viewer through a HarmonyOS USB reverse tunnel."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import signal
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit


HERE = Path(__file__).resolve().parent
LOOPBACK = "127.0.0.1"
DEFAULT_MAC_PORT = 54321
DEFAULT_VIEWER_PORT = 54323
MAC_APP = HERE.parent / "MacHost/.build/SideScreen Harmony.app"


def pixel_size(width, height):
    width, height = int(width), int(height)
    if not (480 <= min(width, height) <= 4320 and max(width, height) <= 7680):
        raise ValueError("invalid panel size")
    return width & ~1, height & ~1


def encode_size(size):
    return bytes(0x80 | (side >> shift) & 0x7F for side in size for shift in (7, 0))


def stream_capabilities(query, panel):
    params = parse_qs(query)
    codec = params.get("codec", ["avc"])[0]
    if codec not in ("avc", "hevc"):
        raise ValueError("invalid codec")
    hello = bytearray((9,)) if codec == "avc" else bytearray()
    if panel is None and "w" in params and "h" in params:
        panel = pixel_size(params["w"][0], params["h"][0])
    if panel is not None:
        target = tuple(sorted(panel, reverse=True))
        # A 60 Hz decoding budget, advertised independently of the panel size.
        limit = target
        if "compat" in params:
            limit = tuple(max(256, side // 2) for side in target)
        elif "low_latency" in params:
            limit = tuple(max(256, (side * 2 // 3) & ~1) for side in target)
        hello.extend((11, *encode_size(limit), 19, *encode_size(target)))
    hello.append(8)
    return hello


def find_hdc():
    override = os.environ.get("SIDESCREEN_HDC")
    if override:
        return shutil.which(override)
    studios = (Path("/Applications"), Path.home() / "Applications")
    candidates = [
        "hdc",
        Path.home() / "Library/Application Support/SideScreen/HarmonyOS/toolchains/hdc",
    ]
    for studio in studios:
        for sdk in ("openharmony", "HarmonyOS"):
            candidates.append(studio / "DevEco Studio.app/Contents/sdk/default" / sdk / "toolchains/hdc")
    for candidate in candidates:
        executable = shutil.which(candidate)
        if executable:
            return executable
    return None


def mac_port():
    domain = "com.sidescreen.harmony" if MAC_APP.is_dir() else "com.sidescreen.app"
    try:
        value = subprocess.check_output(
            ["defaults", "read", domain, "SideScreen_port"],
            stderr=subprocess.DEVNULL, text=True, timeout=2,
        )
        return port_number(value)
    except (OSError, subprocess.SubprocessError, ValueError):
        return DEFAULT_MAC_PORT


def port_number(value):
    port = int(value)
    if not 1 <= port <= 65535:
        raise ValueError("端口必须在 1 到 65535 之间")
    return port


class UsbTunnel:
    def __init__(self, hdc, port, device):
        self.hdc = hdc
        self.endpoint = f"tcp:{port}"
        self.url = f"http://{LOOPBACK}:{port}/"
        self.device = device
        self.owned_targets = set()

    def run(self, *args):
        result = subprocess.run(
            [self.hdc, *args], capture_output=True, text=True, timeout=5,
        )
        return result.stdout + result.stderr

    def target(self):
        rows = [line.split() for line in self.run("list", "targets", "-v").splitlines() if line.strip()]
        if self.device:
            rows = [fields for fields in rows if fields[0] == self.device]
        targets = []
        for fields in rows:
            if fields[1:3] == ["USB", "Connected"]:
                targets.append(fields[0])
        if len(targets) > 1:
            raise RuntimeError("连接了多台鸿蒙设备，请用 --device 指定平板。")
        if not targets:
            if any("Unauthorized" in fields[1:3] for fields in rows):
                raise RuntimeError("平板尚未授权，请解锁并点击「允许 USB 调试」。")
            if any(fields[1:3] == ["TCP", "Connected"] for fields in rows):
                raise RuntimeError("只检测到了无线调试。请用数据线直连 Mac，并开启平板的「USB 调试」。")
        return targets[0] if targets else None

    def ensure(self, target):
        active = self.run("-t", target, "fport", "ls")
        for line in active.splitlines():
            fields = line.split()
            if fields[:2] != [target, self.endpoint] or fields[-1] != "[Reverse]":
                continue
            if fields[2:] == [self.endpoint, "[Reverse]"]:
                return
            raise RuntimeError(f"平板端 {self.endpoint} 已被另一个转发占用，请用 --port 指定其他端口。")
        output = self.run("-t", target, "rport", self.endpoint, self.endpoint)
        if "Forwardport result:OK" not in output:
            raise RuntimeError(f"USB 转发失败。{output.strip()}")
        self.owned_targets.add(target)

    def panel_size(self, target):
        # The browser's CSS pixels can be scaled by system display settings.
        try:
            output = self.run("-t", target, "shell", "hidumper -s RenderService -a screen")
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.search(r"physical resolution=(\d+)x(\d+), isVirtual=false", output)
        if match:
            try:
                return pixel_size(*match.groups())
            except ValueError:
                pass
        return None

    def open_viewer(self, target):
        assets = b"".join((HERE / name).read_bytes() for name in ("index.html", "viewer.js", "decoder-worker.js"))
        version = hashlib.sha256(assets).hexdigest()[:12]
        separator = "&" if "?" in self.url else "?"
        url = f"{self.url}{separator}v={version}"
        output = self.run("-t", target, "shell", "aa", "start", "-A", "ohos.want.action.viewData", "-U", url)
        if "start ability successfully" in output:
            return
        if "10106102" in output:
            raise RuntimeError("平板已锁屏，解锁后会自动打开副屏。")
        print(f"请在平板浏览器打开 {self.url}。{output.strip()}", flush=True)

    def close(self):
        for target in self.owned_targets:
            try:
                self.run("-t", target, "fport", "rm", self.endpoint, self.endpoint)
            except (OSError, subprocess.SubprocessError):
                pass


class ViewerServer(ThreadingHTTPServer):
    def __init__(self, viewer_port, source_port):
        super().__init__((LOOPBACK, viewer_port), ViewerHandler)
        self.source_port = source_port
        self.stream_lock = threading.Lock()
        self.active_stream = None
        self.usb_ready = threading.Event()
        self.panel_size = None
        self.viewer_metrics = {}


class ViewerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 5
    disable_nagle_algorithm = True

    def is_local_request(self):
        expected_host = f"{LOOPBACK}:{self.server.server_port}"
        if self.headers.get("Host") != expected_host or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_error(403)
            return False
        return True

    def do_POST(self):
        if not self.is_local_request():
            return
        if self.path != "/keyframe":
            self.send_error(404)
            return
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
            self.close_connection = True
            self.send_error(400)
            return
        token, keyframe_requested = self.server.active_stream or (None, None)
        if keyframe_requested is None or self.headers.get("X-SideScreen-Stream") != token:
            self.send_error(409, "Stream has changed")
            return
        keyframe_requested.set()
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self):
        received_us = time.monotonic_ns() // 1000
        if not self.is_local_request():
            return
        path = urlsplit(self.path)
        if path.path == "/stream":
            try:
                hello = stream_capabilities(path.query, self.server.panel_size)
            except ValueError:
                self.send_error(400, "Invalid stream parameters")
                return
            self.serve_stream(hello)
            return
        if path.path == "/ping":
            self.serve_ping(received_us, path.query)
        elif path.path == "/metrics":
            data = json.dumps(self.server.viewer_metrics).encode("utf-8")
            self.headers_for("application/json", len(data))
            self.wfile.write(data)
        elif path.path == "/":
            self.serve_page()
        elif path.path in ("/viewer.js", "/decoder-worker.js"):
            self.serve_file(path.path[1:], "text/javascript; charset=utf-8")
        elif self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(404)

    def headers_for(self, content_type, length=None, stream_token=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))
        if stream_token is not None:
            self.send_header("X-SideScreen-Transport", "usb")
            self.send_header("X-SideScreen-Stream", stream_token)
            self.send_header("Connection", "close")
        self.end_headers()

    def serve_ping(self, received_us, query):
        if not self.server.usb_ready.is_set():
            self.send_error(503, "USB tunnel unavailable")
            return
        values = parse_qs(query)
        metrics = {}
        for name in ("frameMs", "decodeMs", "renderMs", "fetchMs", "httpMs", "requestQueueMs", "scheduleMs",
                     "worker", "receivedFps", "drawnFps", "lastDrawAgeMs"):
            try:
                value = float(values[name][0])
            except (KeyError, ValueError):
                continue
            if 0 <= value <= 60000:
                metrics[name] = round(value, 2)
        if metrics:
            self.server.viewer_metrics = {**metrics, "updatedAt": time.monotonic()}
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-SideScreen-Received-Us", str(received_us))
        self.send_header("X-SideScreen-Sent-Us", str(time.monotonic_ns() // 1000))
        self.end_headers()

    def serve_file(self, name, content_type):
        data = (HERE / name).read_bytes()
        self.headers_for(content_type, len(data))
        self.wfile.write(data)

    def serve_page(self):
        data = (HERE / "index.html").read_bytes()
        if self.server.panel_size:
            width, height = sorted(self.server.panel_size, reverse=True)
            data = data.replace(b"<main>", f'<main data-width="{width}" data-height="{height}">'.encode("ascii"))
        self.headers_for("text/html; charset=utf-8", len(data))
        self.wfile.write(data)

    def serve_stream(self, hello):
        if not self.server.usb_ready.is_set():
            self.send_error(503, "USB tunnel unavailable")
            return
        if not self.server.stream_lock.acquire(blocking=False):
            self.send_error(409, "Another viewer is already connected")
            return
        try:
            try:
                source = socket.create_connection((LOOPBACK, self.server.source_port), timeout=2)
            except OSError:
                self.send_error(502, "Start USB streaming in SideScreen on the Mac")
                return
            with source:
                source.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                source.sendall(hello)
                token = secrets.token_hex(12)
                keyframe_requested = threading.Event()
                self.server.active_stream = (token, keyframe_requested)
                self.server.viewer_metrics = {}
                self.headers_for("application/octet-stream", stream_token=token)
                while self.server.usb_ready.is_set():
                    if keyframe_requested.is_set():
                        keyframe_requested.clear()
                        source.sendall(bytes((7, 0)))  # SideScreen's throttled keyframe request.
                    ready, _, _ = select.select([source, self.connection], [], [], 0.25)
                    if self.connection in ready:
                        return
                    if source not in ready:
                        continue
                    data = source.recv(65536)
                    if not data:
                        return
                    self.wfile.write(data)
        except OSError:
            pass
        finally:
            self.server.active_stream = None
            self.server.stream_lock.release()

    def log_message(self, _format, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description="通过 USB 把 SideScreen 扩展屏显示在鸿蒙平板上。")
    parser.add_argument("--port", type=port_number, default=DEFAULT_VIEWER_PORT, help="平板浏览器端口")
    parser.add_argument("--mac-port", type=port_number, default=mac_port(), help="Mac SideScreen 的串流端口")
    parser.add_argument("--device", help="多台设备时的 USB 设备标识，可用 hdc list targets -v 查看")
    parser.add_argument("--no-open", action="store_true", help="由你在平板上手动打开浏览器")
    parser.add_argument("--no-start-mac", action="store_true", help="连接已经运行的 Mac 串流服务")
    parser.add_argument("--status-json", action="store_true", help="向 Mac 应用输出 JSON 连接状态")
    parser.add_argument("--parent-pid", type=int, help="随启动此服务的 Mac 应用退出")
    args = parser.parse_args()
    hdc = find_hdc()
    if hdc is None:
        parser.exit(1, "找不到 hdc。请安装 DevEco Studio，或设置 SIDESCREEN_HDC 指向 SDK 的 hdc。\n")
    try:
        server = ViewerServer(args.port, args.mac_port)
    except OSError as error:
        parser.exit(1, f"无法监听平板浏览器端口 {args.port}。{error}\n")

    tunnel = UsbTunnel(hdc, args.port, args.device)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"SideScreen 鸿蒙副屏  {tunnel.url}", flush=True)
    print(f"Mac 上的 SideScreen 需在 USB 模式开始串流，端口为 {args.mac_port}。", flush=True)
    previous_status = None
    should_open = not args.no_open
    last_target = None

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)

    def reopen(_signal, _frame):
        nonlocal should_open
        should_open = True

    signal.signal(signal.SIGUSR1, reopen)
    mac_process = None
    start_mac = not args.no_start_mac
    try:
        while True:
            if args.parent_pid is not None and os.getppid() != args.parent_pid:
                break
            usb_ready = False
            try:
                target = tunnel.target()
                if target != last_target:
                    server.usb_ready.clear()
                    server.panel_size = tunnel.panel_size(target) if target else None
                    last_target = target
                    should_open = not args.no_open
                if target is None:
                    status = "未检测到鸿蒙 USB 调试设备。请解锁平板、开启 USB 调试，并用数据线直连 Mac。"
                else:
                    tunnel.ensure(target)
                    server.usb_ready.set()
                    usb_ready = True
                    size = server.panel_size
                    panel = f"（{max(size)}×{min(size)}）" if size else ""
                    status = f"USB 已连接{panel}，平板浏览器地址为 {tunnel.url}"
                    if start_mac:
                        if MAC_APP.is_dir():
                            mac_process = subprocess.Popen([
                                MAC_APP / "Contents/MacOS/SideScreen", "--harmony-usb", "-SideScreen_port", str(args.mac_port),
                            ])
                        else:
                            subprocess.run(["/usr/bin/open", "-g", "-b", "com.sidescreen.app"], check=False)
                        start_mac = False
                    if should_open:
                        tunnel.open_viewer(target)
                        should_open = False
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                status = str(error)
            if not usb_ready:
                server.usb_ready.clear()
            if status != previous_status:
                if args.status_json:
                    print(json.dumps({"connected": usb_ready, "message": status}, ensure_ascii=False), flush=True)
                else:
                    print(status, flush=True)
                previous_status = status
            time.sleep(3)
    except KeyboardInterrupt:
        print("\nSideScreen 鸿蒙副屏已停止。", flush=True)
    finally:
        tunnel.close()
        server.shutdown()
        server.server_close()
        if mac_process and mac_process.poll() is None:
            mac_process.terminate()
            try:
                mac_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mac_process.kill()
                mac_process.wait()


if __name__ == "__main__":
    main()
