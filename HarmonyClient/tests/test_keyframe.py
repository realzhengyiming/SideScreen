import http.client
from pathlib import Path
import socket
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import LOOPBACK, ViewerServer


class KeyframeRequestTest(unittest.TestCase):
    def test_only_the_current_viewer_can_request_a_new_keyframe(self):
        with socket.socket() as host:
            host.bind((LOOPBACK, 0))
            host.listen()
            host.settimeout(2)
            with ViewerServer(0, host.getsockname()[1]) as bridge:
                bridge.usb_ready.set()
                thread = threading.Thread(target=bridge.serve_forever, daemon=True)
                thread.start()

                def request(token, site="same-origin"):
                    connection = http.client.HTTPConnection(LOOPBACK, bridge.server_port, timeout=2)
                    try:
                        connection.request("POST", "/keyframe", headers={"X-SideScreen-Stream": token, "Sec-Fetch-Site": site})
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
                            self.assertNotEqual(token, previous_token)
                            with host.accept()[0] as source:
                                source.settimeout(2)
                                with source.makefile("rb") as wire:
                                    self.assertEqual(wire.read(1), bytes((8,)))
                                    self.assertEqual(request(previous_token), 409)
                                    self.assertEqual(request(token, "cross-site"), 403)
                                    self.assertEqual(request(token), 204)
                                    self.assertEqual(wire.read(2), bytes((7, 0)))
                            response.read()
                        finally:
                            viewer.close()
                        previous_token = token
                    self.assertEqual(request(previous_token), 409)
                finally:
                    bridge.shutdown()
                    thread.join()
