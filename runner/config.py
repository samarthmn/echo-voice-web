"""Read shared public settings and initialize the per-library runner credential."""
try:
    import fcntl
except ImportError:
    fcntl = None  # --doctor must still explain unsupported Windows capture.
import json
import os
from pathlib import Path
import re
import uuid
from urllib.parse import urlparse


def load_config():
    """Use the same runtime file and test overrides as the Rust server."""
    path = Path(os.environ.get("ECHO_CONFIG_FILE", "echo.config.json"))
    config = json.loads(path.read_text(encoding="utf8"))
    data = Path(os.environ.get("ECHO_DATA_DIR", config["dataDir"])).resolve()
    url = urlparse(config["runner"]["url"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("The runner URL must be http://127.0.0.1:<port>.")
    timeout = config["runner"]["admissionTimeoutSeconds"]
    if type(timeout) is not int or not 1 <= timeout <= 3600 or type(config["runner"]["headless"]) is not bool:
        raise ValueError("Runner admission timeout must be 1–3600 seconds and headless must be a boolean.")
    return config, data, url.port or 80


def runner_token(data):
    """Publish a private random secret atomically under a lock shared with Rust."""
    if fcntl is None:
        raise ValueError("Runner credentials require a Unix file lock; capture supports Linux only.")
    folder = data / "credentials"
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    if folder.is_symlink():
        raise ValueError("The credentials folder must not be a symbolic link.")
    folder.chmod(0o700)
    path, lock_path = folder / "runner-token", folder / "runner-token.lock"
    if path.is_symlink() or lock_path.is_symlink():
        raise ValueError("Runner credentials must not be symbolic links.")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.exists():
            temporary = folder / ("." + uuid.uuid4().hex + ".tmp")
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as output:
                    output.write(uuid.uuid4().hex + uuid.uuid4().hex)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(path)
                directory = os.open(folder, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                temporary.unlink(missing_ok=True)
        token = path.read_text(encoding="utf8")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", token):
            raise ValueError("Invalid generated runner credential. Stop both processes and remove credentials/runner-token to regenerate it.")
        path.chmod(0o600)
        return token
