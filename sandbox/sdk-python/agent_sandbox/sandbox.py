# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Main Sandbox class — E2B-style entry point."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Generator, Optional

if TYPE_CHECKING:
    import requests

from .clients.control_plane import ControlPlaneClient
from .clients.data_plane import DataPlaneClient
from .exceptions import SandboxError
from .files import Files
from .session import ExecResult, SessionManager


class Sandbox:
    """
    An isolated sandbox environment for running code, managing files, and
    interacting with GPU resources.

    Usage (context manager — auto-cleanup)::

        with Sandbox(template="python-3.11") as sbx:
            result = sbx.exec("echo hello")
            print(result.stdout)

            session = sbx.session.create()
            session.exec("cd /tmp")
            session.exec("ls")   # still in /tmp

            sbx.files.write("script.py", "print('hello')")
            sbx.exec("python3 script.py")

    Usage (manual lifecycle)::

        sbx = Sandbox(template="python-3.11")
        sbx.open()
        sbx.exec("...")
        sbx.close()

    LLM Inference (unified inference gateway)::

        When the platform has inference enabled (inference.enabled=true in Helm
        values), OPENAI_BASE_URL is injected as a Pod env var (pointing to the
        platform LiteLLM gateway), and OPENAI_API_KEY is injected at process
        level by EnvD when executing commands (from the user's SaFE API Key
        stored in Redis). Code inside the sandbox can use ``import openai``
        directly without any additional configuration.

        **Limitation**: The unified inference gateway requires API Key
        authentication (SDK / CLI). Sandboxes created via Cookie authentication
        (browser) do NOT receive OPENAI_API_KEY injection.

        Three usage patterns:
        - **Platform LLM (default)**: ``import openai`` works out of the box
        - **Own public LLM**: Override base_url/api_key in your code
        - **Own internal LLM**: Declare allowedInternalHosts in template

    Egress Traffic Governance (transparent proxy + SSRF protection)::

        When egress is enabled (egress.enabled=true), all outbound TCP traffic
        from user code is intercepted by a transparent proxy embedded in EnvD.
        External public endpoints (e.g. example.com) are allowed; private
        network addresses (RFC 1918, cloud metadata 169.254.x.x, etc.) are
        blocked to prevent SSRF attacks.

        Key behaviors:
        - **Public internet**: Allowed (HTTPS with SNI passthrough, HTTP)
        - **Private networks**: Blocked (10/8, 172.16/12, 192.168/16, 169.254/16)
        - **Cloud metadata**: Always blocked (169.254.169.254)
        - **DNS rebinding**: Protected (resolved IPs are validated before connect)
        - **User code runs as root** with full functionality (pip, apt, etc.)
        - **Capabilities dropped at runtime**: NET_ADMIN, NET_RAW, SETGID
    """

    def __init__(
        self,
        template: str,
        *,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        namespace: str = "default",
        timeout: float = 120.0,
        verify_ssl: Optional[bool] = None,
        overrides: Optional[dict] = None,
    ) -> None:
        """
        Args:
            template: Name of the CodeInterpreter template to use.
            api_url:  Unified gateway URL. Defaults to SANDBOX_API_URL env var.
            api_key:  SaFE API Key (Bearer token). Defaults to SANDBOX_API_KEY env var.
            namespace: K8s namespace for the sandbox.
            timeout:  Connection timeout in seconds.
            verify_ssl: SSL certificate verification. Defaults to SANDBOX_VERIFY_SSL env var.
            overrides: Optional dict of safe parameter overrides:
                       - environment: dict of env vars to merge
                       - sessionTimeout: idle timeout (e.g. "10m", no hard cap)
                       - maxSessionDuration: max lifetime (e.g. "4h"; default 24h, no hard cap)
                       - runtimeClassName: Pod runtime (e.g. "kata-qemu", non-WarmPool only)
                       - labels: dict of labels to merge
                       - annotations: dict of annotations to merge
        """
        self.template = template
        self.namespace = namespace
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        self.overrides = overrides

        self.api_url = api_url or os.getenv(
            "SANDBOX_API_URL",
            "https://sandbox.example.com",
        )
        self.api_key = api_key or os.getenv("SANDBOX_API_KEY")

        self._session_id: Optional[str] = None
        self._sandbox_name: Optional[str] = None
        self._cp = ControlPlaneClient(self.api_url, api_key=self.api_key, timeout=timeout, verify_ssl=verify_ssl)
        self._dp: Optional[DataPlaneClient] = None

        # Sub-modules (available after open())
        self.session: Optional[SessionManager] = None
        self.files: Optional[Files] = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def open(self) -> "Sandbox":
        """Create the sandbox and wait for it to be ready."""
        try:
            resp = self._cp.create_sandbox(self.template, namespace=self.namespace, overrides=self.overrides)
        except Exception as e:
            raise SandboxError(f"Failed to create sandbox: {e}") from e

        self._session_id = resp["sessionId"]
        # sandboxName may differ from template name (WM assigns unique name)
        self._sandbox_name = resp.get("sandboxName", self.template)

        self._dp = DataPlaneClient(
            router_url=self.api_url,
            session_id=self._session_id,
            sandbox_name=self._sandbox_name,
            namespace=self.namespace,
            api_key=self.api_key,
            timeout=self.timeout,
            verify_ssl=self.verify_ssl,
        )
        self.session = SessionManager(self._dp)
        self.files = Files(self._dp)
        return self

    def close(self) -> None:
        """Delete the sandbox."""
        if self._session_id:
            try:
                self._cp.delete_sandbox(self._session_id)
            except Exception:
                pass
            self._session_id = None
            self._sandbox_name = None
            self._dp = None
            self.session = None
            self.files = None

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    # ── Context manager ───────────────────────────────────────────────────────

    def __enter__(self) -> "Sandbox":
        return self.open()

    def __exit__(self, *_) -> None:
        self.close()

    # ── Execute ───────────────────────────────────────────────────────────────

    def exec(
        self,
        command: str,
        timeout: str = "60s",
        working_dir: str = "",
        env: Optional[dict] = None,
    ) -> "SandboxExecResult":
        """
        Execute a shell command (stateless — cwd/env do NOT persist).
        For stateful execution use ``sbx.session.create().exec()``.
        """
        self._require_open()
        resp = self._dp.execute(
            command=["sh", "-c", command],
            timeout=timeout,
            working_dir=working_dir,
            env=env,
        )
        return SandboxExecResult(
            stdout=resp.get("stdout", ""),
            stderr=resp.get("stderr", ""),
            exit_code=resp.get("exit_code", 0),
            duration=resp.get("duration", 0.0),
        )

    def exec_stream(
        self,
        command: str,
        timeout: str = "300s",
        env: Optional[dict] = None,
    ) -> Generator[dict, None, None]:
        """Execute a command and stream stdout/stderr as SSE events."""
        self._require_open()
        yield from self._dp.execute_stream(
            command=["sh", "-c", command],
            timeout=timeout,
            env=env,
        )

    def run_code(self, language: str, code: str, timeout: str = "60s") -> "SandboxExecResult":
        """
        Run a code snippet in the sandbox via file-based execution.

        Uses a temp file to avoid shell quoting issues and length limits.

        Args:
            language: "python", "python3", "bash", "sh", "node", etc.
            code: Source code to execute.
            timeout: Execution timeout, e.g. "60s", "5m".
        """
        self._require_open()
        resp = self._dp.run_code(language, code, timeout=timeout)
        return SandboxExecResult(
            stdout=resp.get("stdout", ""),
            stderr=resp.get("stderr", ""),
            exit_code=resp.get("exit_code", 0),
            duration=resp.get("duration", 0.0),
        )

    # ── Service access (port proxy) ───────────────────────────────────────────

    def get_service_url(self, port: int) -> str:
        """Return the Router proxy URL for a service running on *port* inside the sandbox."""
        self._require_open()
        return self._dp.proxy_url(port)

    def http_request(
        self,
        port: int,
        path: str = "/",
        method: str = "GET",
        **kwargs,
    ) -> "requests.Response":
        """Send an HTTP request to a sandbox service via the Router port proxy.

        Args:
            port: Service port inside the sandbox (1-65535, not 8080).
            path: Request path, e.g. "/api/data".
            method: HTTP method.
            **kwargs: Passed to ``requests.Session.request`` (json, data, headers …).
        """
        self._require_open()
        return self._dp.proxy_request(port, path, method, **kwargs)

    def port_forward(self, remote_port: int, local_port: int = 0) -> "PortForward":
        """Create a TCP tunnel: localhost:local_port → sandbox:remote_port.

        Returns a context manager; the tunnel is active inside the ``with`` block.

        Usage::

            with sbx.port_forward(8000) as pf:
                import requests
                requests.get(f"http://localhost:{pf.local_port}/")
        """
        self._require_open()
        return PortForward(self._dp, remote_port, local_port)

    # ── GPU ───────────────────────────────────────────────────────────────────

    def gpu_status(self) -> dict:
        """Query AMD GPU status inside the sandbox."""
        self._require_open()
        return self._dp.gpu_status()

    # ── Policy & logs ─────────────────────────────────────────────────────────

    def get_policy(self) -> dict:
        """Fetch the current effective runtime policy for this sandbox."""
        self._require_open()
        return self._cp.get_policy(self._session_id)

    def update_policy(
        self,
        *,
        allowed_egress_hosts: Optional[list[str]] = None,
        allowed_internal_hosts: Optional[list[str]] = None,
        policy_mode: Optional[str] = None,
    ) -> dict:
        """Patch the sandbox runtime policy."""
        self._require_open()
        return self._cp.update_policy(
            self._session_id,
            allowed_egress_hosts=allowed_egress_hosts,
            allowed_internal_hosts=allowed_internal_hosts,
            policy_mode=policy_mode,
        )

    def get_logs(
        self,
        *,
        source: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        """Query structured sandbox logs, optionally filtered by source/event type."""
        self._require_open()
        return self._cp.get_logs(
            self._session_id,
            source=source,
            event_type=event_type,
            limit=limit,
            offset=offset,
        )

    # ── Sandbox list/detail (class methods — no open() needed) ─────────────

    @staticmethod
    def list(**kwargs) -> dict:
        """List active sandboxes.

        Uses SANDBOX_API_URL and SANDBOX_API_KEY env vars or pass api_url/api_key in kwargs.

        Keyword Args:
            api_url, api_key: Override env vars.
            userId, userName, namespace, status, sessionId, sandboxName: Filters.
            offset, limit, sortBy, order: Pagination and sorting.

        Returns:
            Dict with "totalCount" and "items".
        """
        api_url = kwargs.pop("api_url", None)
        api_key = kwargs.pop("api_key", None)
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.list_sandboxes(**kwargs)

    @staticmethod
    def get(session_id: str, *, api_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
        """Get sandbox detail by session ID."""
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.get_sandbox(session_id)

    # ── Template management (class methods — no open() needed) ───────────

    def open_stream(self) -> Generator["Sandbox", None, None]:
        """Create the sandbox with SSE streaming progress.

        Yields SSE event dicts during creation. The sandbox is ready to use
        after the generator completes (session/files sub-modules are initialised).

        Usage::

            sbx = Sandbox(template="python-3.11")
            for event in sbx.open_stream():
                print(event)
            # sbx is now open
            result = sbx.exec("echo hello")
            sbx.close()
        """
        try:
            for event in self._cp.create_sandbox_stream(
                self.template, namespace=self.namespace, overrides=self.overrides,
            ):
                event_type = event.get("event", "")
                data = event.get("data", {})

                # Capture sessionId from the "end" event
                if event_type == "end" and "sessionId" in data:
                    self._session_id = data["sessionId"]
                    self._sandbox_name = data.get("sandboxName", self.template)

                yield event
        except Exception as e:
            raise SandboxError(f"Failed to create sandbox (stream): {e}") from e

        if not self._session_id:
            raise SandboxError("Streaming creation finished but no sessionId received.")

        self._dp = DataPlaneClient(
            router_url=self.api_url,
            session_id=self._session_id,
            sandbox_name=self._sandbox_name,
            namespace=self.namespace,
            api_key=self.api_key,
            timeout=self.timeout,
            verify_ssl=self.verify_ssl,
        )
        self.session = SessionManager(self._dp)
        self.files = Files(self._dp)

    @staticmethod
    def create_sandbox_stream(template: str, *, namespace: str = "default",
                              overrides: Optional[dict] = None,
                              api_url: Optional[str] = None,
                              api_key: Optional[str] = None) -> Generator[dict, None, None]:
        """Create a sandbox with SSE streaming progress (static, no open() needed).

        Yields dicts with "event" and "data" keys for real-time creation progress.

        This is a low-level static method. For a high-level workflow use
        ``Sandbox.open_stream()`` which also initialises the sandbox for use.
        """
        cp = ControlPlaneClient(api_url, api_key=api_key)
        yield from cp.create_sandbox_stream(template, namespace=namespace, overrides=overrides)

    @staticmethod
    def list_templates(**kwargs) -> dict:
        """List CodeInterpreter templates.

        Permission: default users see only own + public templates; admin roles see all.

        Keyword Args:
            api_url, api_key: Override env vars.
            namespace, userId, userName, name: Filters.
            public: Filter by public status ("true" or "false").
            offset, limit, sortBy, order: Pagination and sorting.

        Returns:
            Dict with "totalCount" and "items".
        """
        api_url = kwargs.pop("api_url", None)
        api_key = kwargs.pop("api_key", None)
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.list_templates(**kwargs)

    @staticmethod
    def get_template(name: str, *, namespace: str = "default",
                     api_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
        """Get a single template by name."""
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.get_template(name, namespace=namespace)

    @staticmethod
    def create_template(name: str, spec: dict, *, namespace: str = "default",
                        public: bool = False, dockerfile: Optional[str] = None,
                        api_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
        """Create a new CodeInterpreter template.

        When warmPoolSize > 0, blocks until the first WarmPool Pod is Ready/Failed
        and returns build_log with per-phase diagnostics.

        Args:
            public: Mark template as publicly visible/usable by all users.
                    Only system-admin can set this to True.
        """
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.create_template(name, spec, namespace=namespace, public=public, dockerfile=dockerfile)

    @staticmethod
    def create_template_stream(name: str, spec: dict, *, namespace: str = "default",
                               public: bool = False, dockerfile: Optional[str] = None,
                               api_url: Optional[str] = None, api_key: Optional[str] = None) -> Generator[dict, None, None]:
        """Create a template with SSE streaming progress.

        Yields dicts with "event" and "data" keys for real-time build progress.

        Args:
            public: Mark template as publicly visible/usable by all users.
        """
        cp = ControlPlaneClient(api_url, api_key=api_key)
        yield from cp.create_template_stream(name, spec, namespace=namespace, public=public, dockerfile=dockerfile)

    @staticmethod
    def update_template(name: str, spec: dict, *, namespace: str = "default",
                        public: Optional[bool] = None,
                        api_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
        """Update a template's spec (full replace).

        Args:
            public: Optionally change public visibility (only system-admin can change this).
        """
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.update_template(name, spec, namespace=namespace, public=public)

    @staticmethod
    def delete_template(name: str, *, namespace: str = "default",
                        api_url: Optional[str] = None, api_key: Optional[str] = None) -> bool:
        """Delete a template."""
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.delete_template(name, namespace=namespace)

    # ── Health check ────────────────────────────────────────────────────────

    @staticmethod
    def health(*, api_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
        """Check service health.

        Returns:
            Dict with health status, e.g. {"status": "ready"}.
        """
        cp = ControlPlaneClient(api_url, api_key=api_key)
        return cp.health()

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _require_open(self) -> None:
        if self._dp is None:
            raise SandboxError("Sandbox is not open. Call open() or use as a context manager.")

    def __repr__(self) -> str:
        return f"Sandbox(template={self.template!r}, session_id={self._session_id!r})"


class SandboxExecResult:
    """Result of a stateless exec call."""

    def __init__(self, stdout: str, stderr: str, exit_code: int, duration: float) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.duration = duration

    @property
    def success(self) -> bool:
        return self.exit_code == 0

    def __repr__(self) -> str:
        return (
            f"SandboxExecResult(exit_code={self.exit_code}, "
            f"stdout={self.stdout!r}, stderr={self.stderr!r})"
        )


class PortForward:
    """TCP tunnel: localhost:local_port ↔ WebSocket ↔ sandbox:remote_port.

    Each accepted TCP connection spawns a dedicated WebSocket tunnel through
    the Router's ``/tunnel/{port}`` endpoint.
    """

    def __init__(self, dp: DataPlaneClient, remote_port: int, local_port: int = 0) -> None:
        self._dp = dp
        self._remote_port = remote_port
        self._local_port = local_port or remote_port
        self._server = None
        self._thread = None
        self._running = False

    @property
    def local_port(self) -> int:
        return self._local_port

    def __enter__(self) -> "PortForward":
        import socket
        import threading

        try:
            from websockets.sync.client import connect as _ws_connect  # noqa: F401
        except ImportError:
            raise SandboxError(
                "websockets is required for port_forward. "
                "Install it: pip install websockets>=12.0"
            )

        self._running = True
        self._conns: list = []
        self._handler_threads: list = []
        self._conns_lock = threading.Lock()
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", self._local_port))
        self._server.listen(8)
        self._server.settimeout(1.0)
        self._local_port = self._server.getsockname()[1]

        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_) -> None:
        self._running = False
        if self._server:
            self._server.close()
        with self._conns_lock:
            for c in self._conns:
                try:
                    c.close()
                except Exception:
                    pass
            self._conns.clear()
        if self._thread:
            self._thread.join(timeout=5)
        for t in self._handler_threads:
            t.join(timeout=3)
        self._handler_threads.clear()

    def _accept_loop(self) -> None:
        import logging
        import socket
        import threading

        while self._running:
            try:
                conn, _ = self._server.accept()
                with self._conns_lock:
                    self._conns.append(conn)
                t = threading.Thread(target=self._handle_conn, args=(conn,), daemon=True)
                self._handler_threads.append(t)
                t.start()
            except socket.timeout:
                continue
            except OSError:
                break
            except Exception:
                logging.getLogger(__name__).debug("accept error", exc_info=True)
                break

    def _handle_conn(self, tcp_conn) -> None:
        import logging
        import ssl as ssl_mod
        import threading

        log = logging.getLogger(__name__)

        from websockets.sync.client import connect as ws_connect

        try:
            tunnel_url = self._dp.tunnel_url(self._remote_port)
            headers = {"x-session-id": self._dp.session_id}
            if self._dp.api_key:
                headers["Authorization"] = f"Bearer {self._dp.api_key}"

            ssl_ctx = None
            if not self._dp.verify_ssl:
                ssl_ctx = ssl_mod.create_default_context()
                ssl_ctx.check_hostname = False
                ssl_ctx.verify_mode = ssl_mod.CERT_NONE

            with ws_connect(tunnel_url, additional_headers=headers,
                            ssl=ssl_ctx if tunnel_url.startswith("wss://") else None) as ws:

                def tcp_to_ws():
                    try:
                        while True:
                            data = tcp_conn.recv(32768)
                            if not data:
                                break
                            ws.send(data)
                    except Exception:
                        log.debug("tcp→ws closed", exc_info=True)
                    finally:
                        try:
                            ws.close()
                        except Exception:
                            log.debug("failed to close websocket", exc_info=True)

                def ws_to_tcp():
                    try:
                        for msg in ws:
                            if isinstance(msg, (bytes, bytearray)):
                                tcp_conn.sendall(msg)
                    except Exception:
                        log.debug("ws→tcp closed", exc_info=True)
                    finally:
                        try:
                            tcp_conn.shutdown(2)
                        except Exception:
                            log.debug("tcp shutdown during ws→tcp cleanup failed", exc_info=True)

                t1 = threading.Thread(target=tcp_to_ws, daemon=True)
                t2 = threading.Thread(target=ws_to_tcp, daemon=True)
                t1.start()
                t2.start()
                t1.join()
                t2.join()
        except SandboxError:
            raise
        except Exception:
            log.debug("tunnel connection error", exc_info=True)
        finally:
            tcp_conn.close()
            with self._conns_lock:
                try:
                    self._conns.remove(tcp_conn)
                except ValueError:
                    log.debug("tcp connection already removed from active set", exc_info=True)
