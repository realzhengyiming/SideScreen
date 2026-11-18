import http.client
from pathlib import Path
import socket
import struct
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import LOOPBACK, ViewerServer, valid_touch_batch


class ViewerControlTest(unittest.TestCase):
    def test_touch_batch_requires_complete_messages_on_the_display(self):
        tap = struct.pack("<BBffi", 2, 1, 0, 1, 0)
        self.assertTrue(valid_touch_batch(tap * 16))
        for data in (tap * 17, b"", tap[:-1], tap + b"\x02", struct.pack("<BBffi", 2, 1, float("nan"), 1, 0),
                     struct.pack("<BBffi", 2, 1, 2, 1, 2), struct.pack("<BBffi", 2, 1, 0, 1, 4)):
            with self.subTest(data=data):
                self.assertFalse(valid_touch_batch(data))

    def test_only_the_current_viewer_controls_the_native_stream(self):
        with socket.socket() as host:
            host.bind((LOOPBACK, 0))
            host.listen()
            host.settimeout(2)
            with ViewerServer(0, host.getsockname()[1]) as bridge:
                bridge.usb_ready.set()
                thread = threading.Thread(target=bridge.serve_forever, daemon=True)
                thread.start()

                def request(token, site="same-origin", path="/keyframe", body=None):
                    connection = http.client.HTTPConnection(LOOPBACK, bridge.server_port, timeout=2)
                    try:
                        headers = {"X-SideScreen-Stream": token, "Sec-Fetch-Site": site, "Content-Type": "application/octet-stream"}
                        connection.request("POST", path, body=body, headers=headers)
                        response = connection.getresponse()
                        response.read()
                        return response.status
                    finally:
                        connection.close()

                previous_token = ""
                try:
                    for _ in range(2):
                        viewer = http.client.HTTPConnection(LOOPBACK, bridge.server_port, timeout=2)
                        try:
                            viewer.request("GET", "/stream?codec=hevc")
                            response = viewer.getresponse()
                            token = response.getheader("X-SideScreen-Stream")
                            self.assertTrue(token)
                            self.assertEqual(response.getheader("X-SideScreen-Input"), "touch")
                            self.assertNotEqual(token, previous_token)
                            with host.accept()[0] as source:
                                source.settimeout(2)
                                with source.makefile("rb") as wire:
                                    self.assertEqual(wire.read(1), bytes((8,)))
                                    self.assertEqual(request(previous_token), 409)
                                    self.assertEqual(request(token, "cross-site"), 403)
                                    self.assertEqual(request(token), 204)
                                    self.assertEqual(wire.read(2), bytes((7, 0)))
                                    one = struct.pack("<BBffi", 2, 1, .25, .75, 0)
                                    two = struct.pack("<BBffffi", 2, 2, .25, .75, .50, .60, 3)
                                    self.assertEqual(request(previous_token, path="/touch", body=one), 409)
                                    self.assertEqual(request(token, "cross-site", "/touch", one), 403)
                                    self.assertEqual(request(token, path="/touch", body=two[:-1]), 400)
                                    self.assertEqual(request(token, path="/touch", body=one + two), 204)
                                    self.assertEqual(wire.read(len(one + two)), one + two)
                            response.read()
                        finally:
                            viewer.close()
                        previous_token = token
                    self.assertEqual(request(previous_token), 409)
                finally:
                    bridge.shutdown()
                    thread.join()
