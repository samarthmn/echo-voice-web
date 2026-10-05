"""Native speech HTTP boundaries on a private ephemeral server, without model inference.

Sparse model files and a synthetic marker exercise request/lifecycle checks only;
they are isolated protocol fixtures and never become product qualification data.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlencode
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
BINARY_OVERRIDE = os.environ.get("ECHO_TEST_BINARY")
BINARY = Path(BINARY_OVERRIDE) if BINARY_OVERRIDE else Path("target/debug/echo-server")
if not BINARY.is_absolute():
    BINARY = ROOT / BINARY
BINARY = BINARY.resolve()
MODEL = "onnx-community/whisper-large-v3"
CHECKPOINT = "Xenova/whisper-large-v3"
REVISION = "67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0"
MAX_PCM = 7200 * 16000 * 4


class Server:
    def __init__(self, native=True):
        (ROOT / "tmp").mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="native-speech-http-", dir=ROOT / "tmp")
        self.root = Path(self.directory.name)
        (self.root / "scripts").mkdir()
        (self.root / "web").mkdir()
        for module in ["whisper-alignment.js", "speech-errors.js"]:
            shutil.copyfile(ROOT / "web" / module, self.root / "web" / module)
        shutil.copyfile(ROOT / "scripts/native-speech.mjs", self.root / "scripts/native-speech.mjs")
        (self.root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (self.root / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        env = {**os.environ, "ECHO_BIND": f"127.0.0.1:{self.port}", "ECHO_DATA_DIR": str(self.root / "data"), "TMPDIR": str(self.root / "tmp")}
        env.pop("ECHO_CONFIG_FILE", None)
        if not native:
            env["PATH"] = ""
        self.env = env
        self.log = (self.root / "server.log").open("wb")
        self.child = subprocess.Popen([str(BINARY)], cwd=self.root, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self.request("GET", "/api/health")[0] == 200:
                    return
            except OSError:
                time.sleep(0.02)
        self.close()
        raise RuntimeError("The isolated native HTTP test server did not start")

    def restart_after_crash(self):
        self.child.kill()
        self.child.wait()
        self.child = subprocess.Popen([str(BINARY)], cwd=self.root, env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self.request("GET", "/api/health")[0] == 200:
                    return
            except OSError:
                time.sleep(0.02)
        raise RuntimeError("The isolated native server did not recover after its simulated crash")

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def close(self):
        if self.child.poll() is None:
            self.child.send_signal(signal.SIGINT)
            try:
                self.child.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        self.log.close()
        self.directory.cleanup()

    def seed_protocol_fixture(self):
        cache = self.root / "data/models/native-large-v3"
        model = cache / CHECKPOINT / REVISION
        (model / "onnx").mkdir(parents=True)
        files = []
        for name, size in [("encoder_model_quantized.onnx", 645260435), ("decoder_model_merged_quantized.onnx", 915059840)]:
            path = model / "onnx" / name
            with path.open("wb") as stream:
                stream.truncate(size)
            files.append({"path": path.relative_to(cache).as_posix(), "size": size})
        for name in ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json"]:
            path = model / name
            path.write_bytes(b"{}")
            files.append({"path": path.relative_to(cache).as_posix(), "size": 2})
        marker = {"version": 1, "modelId": MODEL, "checkpoint": CHECKPOINT, "revision": REVISION, "forwardVerified": True, "files": files}
        (cache / "ready.json").write_bytes(json.dumps(marker).encode("utf-8"))


def job_path(job_id, operation="transcribe"):
    return "/api/speech/jobs?" + urlencode({"jobId": job_id, "modelId": MODEL, "operation": operation, "language": "en"})


class NativeSpeechHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BINARY.is_file() or not os.access(BINARY, os.X_OK) or BINARY_OVERRIDE == "":
            message = f"Native HTTP test binary is missing or not executable: {BINARY}. Build echo-server or set ECHO_TEST_BINARY."
            if BINARY_OVERRIDE is not None:
                raise RuntimeError(message)
            raise unittest.SkipTest(message)
        if not shutil.which("node"):
            if BINARY_OVERRIDE is not None:
                raise RuntimeError("Configured native HTTP integration tests require Node.js 22 or newer.")
            raise unittest.SkipTest("Install Node.js 22 or newer for native HTTP tests.")
        cls.server = Server()
        cls.addClassCleanup(cls.server.close)
        if not cls.server.request("GET", "/api/speech")[1]["available"]:
            if BINARY_OVERRIDE is not None:
                raise RuntimeError("Configured native HTTP integration tests require npm ci and Node.js 22+.")
            raise unittest.SkipTest("Native dependencies require npm ci and Node.js 22+")
        cls.server.seed_protocol_fixture()

    def wait_job(self, job_id, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, job = self.server.request("GET", f"/api/speech/jobs/{job_id}")
            if status == 200 and predicate(job):
                return job
            time.sleep(0.02)
        self.fail("The isolated job did not reach its expected state")

    def assert_idle_clean(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.server.request("GET", "/api/speech")[1]
            leftovers = list((self.server.root / "tmp").glob("native-speech-*"))
            if state["activeJob"] is None and not leftovers:
                return
            time.sleep(0.02)
        self.fail("Owned job/upload did not release its slot and spool")

    def test_cancel_before_post_fences_late_start(self):
        job_id = str(uuid4())
        self.assertEqual(self.server.request("DELETE", f"/api/speech/jobs/{job_id}")[0], 200)
        status, error = self.server.request("POST", job_path(job_id, "download"))
        self.assertEqual(status, 409)
        self.assertIn("cancelled", error["error"])
        self.assert_idle_clean()

    def test_rejects_oversized_declared_body_without_receiving_audio(self):
        status, error = self.server.request("POST", job_path(str(uuid4())), headers={"Content-Type": "application/octet-stream", "Content-Length": str(MAX_PCM + 4)})
        self.assertEqual(status, 413)
        self.assertIn("two hours", error["error"])
        self.assert_idle_clean()

    def test_malformed_pcm_length_and_content_type(self):
        status, _ = self.server.request("POST", job_path(str(uuid4())), b"123", {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 400)
        status, _ = self.server.request("POST", job_path(str(uuid4())), b"1234", {"Content-Type": "application/json"})
        self.assertEqual(status, 415)
        self.assert_idle_clean()

    def test_nonfinite_pcm_rejected_by_actual_helper_before_model_loading(self):
        job_id = str(uuid4())
        status, _ = self.server.request("POST", job_path(job_id), struct.pack("<f", float("nan")), {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 202)
        job = self.wait_job(job_id, lambda job: job["state"] == "failed")
        self.assertIn("non-finite", job["error"])
        self.assertNotIn("result", job)
        self.assert_idle_clean()

    def pending_upload(self, job_id):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        connection.putrequest("POST", job_path(job_id))
        connection.putheader("Content-Type", "application/octet-stream")
        connection.putheader("Content-Length", "64")
        connection.endheaders()
        connection.send(struct.pack("<f", 0.0))
        self.wait_job(job_id, lambda job: job["state"] == "queued")
        return connection

    def test_cancel_during_upload_prevents_child_start(self):
        job_id = str(uuid4())
        connection = self.pending_upload(job_id)
        try:
            status, _ = self.server.request("POST", job_path(str(uuid4()), "download"))
            self.assertEqual(status, 409)
            self.assertEqual(self.server.request("DELETE", f"/api/speech/jobs/{job_id}")[0], 200)
            self.assertEqual(connection.getresponse().status, 409)
        finally:
            connection.close()
        job = self.wait_job(job_id, lambda job: job["state"] == "cancelled")
        self.assertNotIn("result", job)
        self.assert_idle_clean()

    def test_aborted_upload_releases_slot_and_owned_spool(self):
        job_id = str(uuid4())
        connection = self.pending_upload(job_id)
        connection.close()
        job = self.wait_job(job_id, lambda job: job["state"] == "failed")
        self.assertNotIn("result", job)
        self.assert_idle_clean()

    def test_pending_chunked_download_body_is_cancellable(self):
        job_id = str(uuid4())
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        try:
            connection.putrequest("POST", job_path(job_id, "download"))
            connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()
            self.wait_job(job_id, lambda job: job["state"] == "queued")
            self.assertEqual(self.server.request("DELETE", f"/api/speech/jobs/{job_id}")[0], 200)
            self.assertEqual(connection.getresponse().status, 409)
        finally:
            connection.close()
        self.wait_job(job_id, lambda job: job["state"] == "cancelled")
        self.assert_idle_clean()

    def test_download_rejects_declared_audio_body_before_reservation(self):
        status, _ = self.server.request("POST", job_path(str(uuid4()), "download"), headers={"Content-Length": "64"})
        self.assertEqual(status, 400)
        self.assert_idle_clean()

    def test_crash_recovery_cleans_same_library_spool_and_preserves_other_library(self):
        job_id = str(uuid4())
        connection = self.pending_upload(job_id)
        data = self.server.root / "data"
        identity = hashlib.sha256(os.fsencode(data.resolve())).hexdigest()
        orphan = self.server.root / "tmp" / f"native-speech-{identity}" / job_id
        other_data = self.server.root / "other-library"
        other_data.mkdir()
        other_id = hashlib.sha256(os.fsencode(other_data.resolve())).hexdigest()
        other_namespace = self.server.root / "tmp" / f"native-speech-{other_id}"
        other_job = other_namespace / str(uuid4())
        other_job.mkdir(parents=True)
        (other_job / "audio.f32").write_bytes(b"other live library")
        try:
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not (orphan / "audio.f32").exists():
                time.sleep(0.01)
            self.assertTrue((orphan / "audio.f32").exists())
            # A competing server must fail the library lock before touching spools.
            contender = subprocess.run([str(BINARY)], cwd=self.server.root, env={**self.server.env, "ECHO_BIND": "127.0.0.1:0"}, capture_output=True, timeout=5)
            self.assertNotEqual(contender.returncode, 0)
            self.assertTrue(orphan.exists())
            self.server.restart_after_crash()
            self.assertFalse(orphan.exists())
            self.assertEqual((other_job / "audio.f32").read_bytes(), b"other live library")
            self.assertIsNone(self.server.request("GET", "/api/speech")[1]["activeJob"])
        finally:
            connection.close()
            shutil.rmtree(other_namespace)
            other_data.rmdir()
        self.assert_idle_clean()

    def test_unavailable_runtime_is_actionable_and_releases_reservation(self):
        server = Server(native=False)
        try:
            status = server.request("GET", "/api/speech")[1]
            self.assertFalse(status["available"])
            self.assertFalse(status["ready"])
            self.assertIn("Node.js 22", status["detail"])
            job_id = str(uuid4())
            response, _ = server.request("POST", job_path(job_id, "download"))
            self.assertEqual(response, 503)
            self.assertIsNone(server.request("GET", "/api/speech")[1]["activeJob"])
            self.assertEqual(list((server.root / "tmp").glob("native-speech-*")), [])
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
