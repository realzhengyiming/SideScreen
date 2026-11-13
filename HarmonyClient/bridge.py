#!/usr/bin/env python3
"""Serve the SideScreen viewer through a HarmonyOS USB reverse tunnel."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import threading
import time


HERE = Path(__file__).resolve().parent
LOOPBACK = "127.0.0.1"
DEFAULT_MAC_PORT = 54321
DEFAULT_VIEWER_PORT = 54323
# Ask the host for H.264 before opting in to frames with timing metadata.
STREAM_CAPABILITIES = bytes((9, 8))


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
    try:
        value = subprocess.check_output(
            ["defaults", "read", "com.sidescreen.app", "SideScreen_port"],
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
        targets = []
        for line in self.run("list", "targets", "-v").splitlines():
            fields = line.split()
            if fields[1:3] == ["USB", "Connected"]:
                targets.append(fields[0])
        if self.device:
            return self.device if self.device in targets else None
        if len(targets) > 1:
            raise RuntimeError("连接了多台鸿蒙设备，请用 --device 指定平板。")
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

    def open_viewer(self, target):
        output = self.run("-t", target, "shell", "aa", "start", "-A", "ohos.want.action.viewData", "-U", self.url)
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


class ViewerHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        expected_host = f"{LOOPBACK}:{self.server.server_port}"
        if self.headers.get("Host") != expected_host or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_error(403)
            return
        if self.path == "/stream":
            self.serve_stream()
            return
        if self.path == "/":
            self.serve_file("index.html", "text/html; charset=utf-8")
        elif self.path == "/viewer.js":
            self.serve_file("viewer.js", "text/javascript; charset=utf-8")
        elif self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(404)

    def headers_for(self, content_type, length=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def serve_file(self, name, content_type):
        data = (HERE / name).read_bytes()
        self.headers_for(content_type, len(data))
        self.wfile.write(data)

    def serve_stream(self):
        if not self.server.stream_lock.acquire(blocking=False):
            self.send_error(409, "Another viewer is already connected")
            return
        try:
            try:
                source = socket.create_connection((LOOPBACK, self.server.source_port), timeout=2)
            except OSError:
                self.send_error(503, "Start USB streaming in SideScreen on the Mac")
                return
            with source:
                self.connection.settimeout(5)
                source.sendall(STREAM_CAPABILITIES)
                self.headers_for("application/octet-stream")
                while True:
                    ready, _, _ = select.select([source, self.connection], [], [])
                    if self.connection in ready:
                        return
                    data = source.recv(65536)
                    if not data:
                        return
                    self.wfile.write(data)
        except OSError:
            pass
        finally:
            self.server.stream_lock.release()

    def log_message(self, _format, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description="通过 USB 把 SideScreen 扩展屏显示在鸿蒙平板上。")
    parser.add_argument("--port", type=port_number, default=DEFAULT_VIEWER_PORT, help="平板浏览器端口")
    parser.add_argument("--mac-port", type=port_number, default=mac_port(), help="Mac SideScreen 的串流端口")
    parser.add_argument("--device", help="多台设备时的 USB 设备标识，可用 hdc list targets -v 查看")
    parser.add_argument("--no-open", action="store_true", help="由你在平板上手动打开浏览器")
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

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            try:
                target = tunnel.target()
                if target is None:
                    status = "等待鸿蒙平板连接，请插入数据线并在平板允许 USB 调试。"
                else:
                    tunnel.ensure(target)
                    status = f"USB 已连接，平板浏览器地址为 {tunnel.url}"
                    if should_open:
                        tunnel.open_viewer(target)
                        should_open = False
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                status = str(error)
            if status != previous_status:
                print(status, flush=True)
                previous_status = status
            time.sleep(3)
    except KeyboardInterrupt:
        print("\nSideScreen 鸿蒙副屏已停止。", flush=True)
    finally:
        tunnel.close()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
