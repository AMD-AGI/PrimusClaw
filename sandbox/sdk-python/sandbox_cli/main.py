#!/usr/bin/env python3
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""sandbox-cli — Command-line tool for agent-sandbox.

Usage:
    sandbox-cli health
    sandbox-cli config set --api-url https://sandbox.example.com
    sandbox-cli sandbox create --template python-311-runc [--stream]
    sandbox-cli sandbox exec <session-id> -- python3 -c "print(1+1)" [-w /tmp] [-e FOO=bar]
    sandbox-cli sandbox run-code <session-id> -l python -c "print(1+1)"
    sandbox-cli sandbox get <session-id>
    sandbox-cli sandbox logs <session-id> [--source egress]
    sandbox-cli sandbox list
    sandbox-cli sandbox delete <session-id>
    sandbox-cli policy get <session-id>
    sandbox-cli policy update <session-id> [--mode audit] [--allow-egress host] [--allow-internal cidr]
    sandbox-cli session create <session-id>
    sandbox-cli session exec <session-id> <terminal-id> "ls -la" [-w /tmp]
    sandbox-cli session output <session-id> <terminal-id>
    sandbox-cli session delete <session-id> <terminal-id>
    sandbox-cli files write <session-id> /tmp/hello.txt -c "Hello"
    sandbox-cli files read <session-id> /tmp/hello.txt
    sandbox-cli files upload <session-id> ./local.py /tmp/script.py
    sandbox-cli files download <session-id> /tmp/output.csv ./output.csv
    sandbox-cli files list <session-id> /tmp
    sandbox-cli files delete <session-id> /tmp/old.txt
    sandbox-cli forward <session-id> 8000:8000
    sandbox-cli sandbox exec <session-id> -- python3 -c "print(1+1)" --stream
    sandbox-cli sandbox http <session-id> 8000 /api/data [-X POST] [-d '{"key":"val"}']
"""

from __future__ import annotations

import json
import os
import sys
import urllib3

# Suppress SSL warnings for self-signed certificates (default verify_ssl=False)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Try to use click; fall back to argparse if not available
try:
    import click
    HAS_CLICK = True
except ImportError:
    HAS_CLICK = False

from agent_sandbox.clients.control_plane import ControlPlaneClient
from agent_sandbox.clients.data_plane import DataPlaneClient

# ── Config file ──────────────────────────────────────────────────────────────

CONFIG_PATH = os.path.expanduser("~/.sandbox/config.json")


def load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def save_config(cfg: dict) -> None:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Config saved to {CONFIG_PATH}")


def get_config_value(key: str, default: str = "") -> str:
    cfg = load_config()
    env_key = "SANDBOX_" + key.upper().replace("-", "_")
    return cfg.get(key) or os.getenv(env_key, default)


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_api_url() -> str:
    """Get the unified API gateway URL."""
    url = get_config_value("api_url")
    if not url:
        print("ERROR: Set api_url via 'sandbox-cli config set --api-url <url>'")
        sys.exit(1)
    return url


def get_cp_client() -> ControlPlaneClient:
    api_key = get_config_value("api_key")
    return ControlPlaneClient(workload_manager_url=get_api_url(), api_key=api_key or None)


def resolve_sandbox_name(session_id: str) -> str:
    """Resolve the actual sandbox name from session ID via the control plane."""
    try:
        cp = get_cp_client()
        info = cp.get_sandbox(session_id)
        return info.get("sandboxName", session_id)
    except Exception:
        return session_id


def get_dp_client(session_id: str, sandbox_name: str | None = None, namespace: str = "default") -> DataPlaneClient:
    """Build a DataPlaneClient, resolving sandbox name from CP if not provided."""
    api_key = get_config_value("api_key")
    if sandbox_name is None:
        sandbox_name = resolve_sandbox_name(session_id)
    return DataPlaneClient(
        router_url=get_api_url(),
        session_id=session_id,
        sandbox_name=sandbox_name,
        namespace=namespace,
        api_key=api_key or None,
    )


# ── CLI implementation (click) ────────────────────────────────────────────────

if HAS_CLICK:

    @click.group()
    def cli():
        """sandbox-cli — agent-sandbox command-line tool."""
        pass

    # ── config ─────────────────────────────────────────────────────────────

    @cli.group()
    def config():
        """Manage sandbox-cli configuration."""
        pass

    @config.command("set")
    @click.option("--api-url", help="Unified API gateway URL (all APIs)")
    @click.option("--api-key", help="SaFE API Key (optional)")
    @click.option("--namespace", default="default", help="K8s namespace")
    def config_set(api_url, api_key, namespace):
        """Set configuration values."""
        cfg = load_config()
        if api_url:
            cfg["api_url"] = api_url
            # Remove legacy keys if present
            cfg.pop("router_url", None)
            cfg.pop("workload_manager_url", None)
        if api_key:
            cfg["api_key"] = api_key
        if namespace:
            cfg["namespace"] = namespace
        save_config(cfg)

    @config.command("show")
    def config_show():
        """Show current configuration."""
        cfg = load_config()
        print(json.dumps(cfg, indent=2))

    # ── sandbox ────────────────────────────────────────────────────────────

    @cli.group()
    def sandbox():
        """Manage sandboxes."""
        pass

    @sandbox.command("create")
    @click.option("--template", "-t", required=True, help="CodeInterpreter template name")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    @click.option("--env", "-e", multiple=True, help="Environment variable override (KEY=VALUE, repeatable)")
    @click.option("--session-timeout", default=None, help="Idle timeout override (e.g. 10m, hard cap 15m)")
    @click.option("--max-duration", default=None, help="Max lifetime override (e.g. 4h, hard cap 24h)")
    @click.option("--runtime-class", default=None, help="RuntimeClassName override (e.g. kata-qemu, non-WarmPool only)")
    @click.option("--label", "-l", multiple=True, help="Label override (key=value, repeatable)")
    @click.option("--annotation", "-a", multiple=True, help="Annotation override (key=value, repeatable)")
    @click.option("--stream", is_flag=True, default=False,
                  help="Stream creation progress in real-time via SSE")
    def sandbox_create(template, namespace, env, session_timeout, max_duration, runtime_class, label, annotation, stream):
        """Create a new sandbox session with optional parameter overrides.

        When the platform has inference enabled, OPENAI_BASE_URL is injected as
        a Pod env var, and OPENAI_API_KEY is injected at process level by EnvD.
        Use 'import openai' inside the sandbox directly.

        Note: Inference gateway requires API Key auth (SDK/CLI). Cookie auth
        (browser) does not support inference — OPENAI_API_KEY will not be set.
        """
        ns = namespace or get_config_value("namespace", "default")
        cp = get_cp_client()

        # Build overrides from CLI flags
        overrides = {}
        if env:
            env_map = {}
            for e in env:
                if "=" in e:
                    k, v = e.split("=", 1)
                    env_map[k] = v
            if env_map:
                overrides["environment"] = env_map
        if session_timeout:
            overrides["sessionTimeout"] = session_timeout
        if max_duration:
            overrides["maxSessionDuration"] = max_duration
        if runtime_class is not None:
            overrides["runtimeClassName"] = runtime_class
        if label:
            label_map = {}
            for l in label:
                if "=" in l:
                    k, v = l.split("=", 1)
                    label_map[k] = v
            if label_map:
                overrides["labels"] = label_map
        if annotation:
            anno_map = {}
            for a in annotation:
                if "=" in a:
                    k, v = a.split("=", 1)
                    anno_map[k] = v
            if anno_map:
                overrides["annotations"] = anno_map

        if stream:
            print(f"Creating sandbox from template '{template}'...", file=sys.stderr)
            for event in cp.create_sandbox_stream(template, namespace=ns, overrides=overrides or None):
                event_type = event.get("event", "")
                data = event.get("data", {})
                if event_type == "phase":
                    phase = data.get("phase", "")
                    status = data.get("status", "")
                    message = data.get("message", "")
                    duration = data.get("duration")
                    if status == "started":
                        print(f"⠋ {phase}: {message}", file=sys.stderr, end="\r")
                    elif status == "completed":
                        dur_str = f" ({duration:.1f}s)" if duration else ""
                        print(f"✓ {phase}{dur_str}    ", file=sys.stderr)
                    elif status == "failed":
                        dur_str = f" ({duration:.1f}s)" if duration else ""
                        print(f"✗ {phase}: {message}{dur_str}", file=sys.stderr)
                elif event_type == "log":
                    stdout = data.get("stdout", "")
                    if stdout:
                        print(f"  │ {stdout}", end="", file=sys.stderr)
                elif event_type == "end":
                    session_id = data.get("sessionId", "")
                    sandbox_name = data.get("sandboxName", "")
                    total_duration = data.get("total_duration")
                    dur_str = f" ({total_duration:.1f}s)" if total_duration else ""
                    if session_id:
                        print(f"\n✅ Sandbox created{dur_str}", file=sys.stderr)
                        print(f"Session ID: {session_id}", file=sys.stderr)
                        # Print JSON to stdout for scripting
                        print(json.dumps(data, indent=2))
                    else:
                        err = data.get("error", "")
                        print(f"\n❌ Sandbox creation failed: {err}{dur_str}", file=sys.stderr)
                        sys.exit(1)
        else:
            resp = cp.create_sandbox(template, namespace=ns, overrides=overrides or None)
            print(json.dumps(resp, indent=2))
            print(f"\n✅ Session ID: {resp['sessionId']}", file=sys.stderr)

    @sandbox.command("list")
    @click.option("--namespace", "-n", default=None, help="Filter by namespace")
    @click.option("--user-id", default=None, help="Filter by user ID")
    @click.option("--user-name", default=None, help="Filter by username (fuzzy)")
    @click.option("--status", default=None, help="Filter by status: running")
    @click.option("--limit", default=100, type=int, help="Items per page")
    @click.option("--offset", default=0, type=int, help="Pagination offset")
    @click.option("--sort-by", default="createdAt", help="Sort field: createdAt, lastActivity, expiresAt")
    @click.option("--order", default="desc", help="Sort order: desc, asc")
    def sandbox_list(namespace, user_id, user_name, status, limit, offset, sort_by, order):
        """List active sandboxes."""
        cp = get_cp_client()
        kwargs = {"limit": limit, "offset": offset, "sortBy": sort_by, "order": order}
        if namespace:
            kwargs["namespace"] = namespace
        if user_id:
            kwargs["userId"] = user_id
        if user_name:
            kwargs["userName"] = user_name
        if status:
            kwargs["status"] = status
        result = cp.list_sandboxes(**kwargs)
        items = result.get("items", [])
        total = result.get("totalCount", 0)
        if not items:
            print("No sandboxes found.")
            return
        print(f"{'SESSION ID':<40} {'SANDBOX NAME':<35} {'STATUS':<10} {'CREATOR':<20} {'LAST ACTIVE'}")
        for s in items:
            sid = s.get("sessionId", "-")[:38]
            name = s.get("sandboxName", "-")[:33]
            st = s.get("status", "-")
            creator = s.get("userName", "-")[:18]
            activity = s.get("lastActivity", "-")
            print(f"{sid:<40} {name:<35} {st:<10} {creator:<20} {activity}")
        print(f"\nTotal: {total}")

    @sandbox.command("get")
    @click.argument("session_id")
    def sandbox_get(session_id):
        """Get sandbox details by session ID."""
        cp = get_cp_client()
        result = cp.get_sandbox(session_id)
        print(json.dumps(result, indent=2, default=str))

    @sandbox.command("logs")
    @click.argument("session_id")
    @click.option("--source", default=None, help="Filter by source, e.g. egress")
    @click.option("--event-type", default=None, help="Filter by event type, e.g. sandbox.egress")
    @click.option("--limit", default=100, type=int, help="Items per page")
    @click.option("--offset", default=0, type=int, help="Pagination offset")
    def sandbox_logs(session_id, source, event_type, limit, offset):
        """Query structured sandbox logs."""
        cp = get_cp_client()
        result = cp.get_logs(session_id, source=source, event_type=event_type, limit=limit, offset=offset)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    @sandbox.command("exec")
    @click.argument("session_id")
    @click.argument("command", nargs=-1, required=True)
    @click.option("--namespace", "-n", default=None)
    @click.option("--timeout", default="60s")
    @click.option("--working-dir", "-w", default="", help="Working directory inside the sandbox")
    @click.option("--env", "-e", multiple=True, help="Environment variable (KEY=VALUE, repeatable)")
    @click.option("--stream", is_flag=True, default=False, help="Stream stdout/stderr in real-time via SSE")
    def sandbox_exec(session_id, command, namespace, timeout, working_dir, env, stream):
        """Execute a command in a sandbox."""
        ns = namespace or get_config_value("namespace", "default")
        dp = get_dp_client(session_id, namespace=ns)
        env_map = None
        if env:
            env_map = {}
            for e in env:
                if "=" in e:
                    k, v = e.split("=", 1)
                    env_map[k] = v

        if stream:
            exit_code = 0
            for event in dp.execute_stream(list(command), timeout=timeout, working_dir=working_dir, env=env_map):
                event_type = event.get("event", "")
                if event_type == "data":
                    stdout = event.get("stdout", "")
                    stderr = event.get("stderr", "")
                    if stdout:
                        print(stdout, end="", flush=True)
                    if stderr:
                        print(stderr, end="", file=sys.stderr, flush=True)
                elif event_type == "end":
                    exit_code = event.get("exit_code", 0)
            sys.exit(exit_code)
        else:
            result = dp.execute(list(command), timeout=timeout, working_dir=working_dir, env=env_map)
            if result.get("stdout"):
                print(result["stdout"], end="")
            if result.get("stderr"):
                print(result["stderr"], end="", file=sys.stderr)
            sys.exit(result.get("exit_code", 0))

    @sandbox.command("run-code")
    @click.argument("session_id")
    @click.option("--language", "-l", required=True, type=click.Choice(["python", "python3", "bash", "sh"]),
                  help="Programming language")
    @click.option("--code", "-c", default=None, help="Code string to execute")
    @click.option("--file", "-f", "code_file", default=None, type=click.Path(exists=True),
                  help="Read code from a local file")
    @click.option("--namespace", "-n", default=None)
    @click.option("--timeout", default="60s")
    def sandbox_run_code(session_id, language, code, code_file, namespace, timeout):
        """Run a code snippet in a sandbox.

        Provide code via --code or --file. The code is written to a temp file
        inside the sandbox and executed, avoiding shell quoting issues.

        \b
        Examples:
            sandbox-cli sandbox run-code <sid> -l python -c "print('hello')"
            sandbox-cli sandbox run-code <sid> -l bash --file ./script.sh
            echo "print(42)" | sandbox-cli sandbox run-code <sid> -l python -c -
        """
        if code_file:
            with open(code_file) as f:
                code_text = f.read()
        elif code == "-":
            code_text = sys.stdin.read()
        elif code:
            code_text = code
        else:
            print("ERROR: Provide code via --code or --file", file=sys.stderr)
            sys.exit(1)
        ns = namespace or get_config_value("namespace", "default")
        dp = get_dp_client(session_id, namespace=ns)
        result = dp.run_code(language, code_text, timeout=timeout)
        if result.get("stdout"):
            print(result["stdout"], end="")
        if result.get("stderr"):
            print(result["stderr"], end="", file=sys.stderr)
        sys.exit(result.get("exit_code", 0))

    @sandbox.command("delete")
    @click.argument("session_id")
    def sandbox_delete(session_id):
        """Delete a sandbox session."""
        cp = get_cp_client()
        ok = cp.delete_sandbox(session_id)
        if ok:
            print(f"✅ Session {session_id} deleted")
        else:
            print(f"❌ Failed to delete session {session_id}", file=sys.stderr)
            sys.exit(1)

    @sandbox.command("http")
    @click.argument("session_id")
    @click.argument("port", type=int)
    @click.argument("path", default="/")
    @click.option("--method", "-X", default="GET", help="HTTP method (GET, POST, PUT, DELETE, ...)")
    @click.option("--data", "-d", default=None, help="Request body (JSON string)")
    @click.option("--header", "-H", multiple=True, help="Extra header (Key: Value, repeatable)")
    @click.option("--namespace", "-n", default=None)
    @click.option("--output", "-o", default=None, type=click.Path(), help="Save response body to file")
    def sandbox_http(session_id, port, path, method, data, header, namespace, output):
        """Send an HTTP request to a service running inside a sandbox.

        Routes through the Router port proxy so the sandbox service does
        not need to be publicly exposed.

        \b
        Examples:
            sandbox-cli sandbox http <sid> 8000 /api/health
            sandbox-cli sandbox http <sid> 8000 /api/data -X POST -d '{"key":"val"}'
            sandbox-cli sandbox http <sid> 3000 /metrics -H "Accept: text/plain"
        """
        ns = namespace or get_config_value("namespace", "default")
        dp = get_dp_client(session_id, namespace=ns)
        kwargs = {}
        if data is not None:
            try:
                kwargs["json"] = json.loads(data)
            except json.JSONDecodeError:
                kwargs["data"] = data
        if header:
            hdrs = {}
            for h in header:
                if ":" in h:
                    k, v = h.split(":", 1)
                    hdrs[k.strip()] = v.strip()
            if hdrs:
                kwargs["headers"] = hdrs

        resp = dp.proxy_request(port, path, method, raise_for_status=False, **kwargs)

        print(f"HTTP {resp.status_code}", file=sys.stderr)
        if output:
            with open(output, "wb") as f:
                f.write(resp.content)
            print(f"✅ Response saved to {output} ({len(resp.content)} bytes)", file=sys.stderr)
        else:
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type:
                try:
                    print(json.dumps(resp.json(), indent=2, ensure_ascii=False))
                except Exception:
                    print(resp.text)
            else:
                print(resp.text, end="")

        if resp.status_code >= 400:
            sys.exit(1)

    # ── session ────────────────────────────────────────────────────────────

    @cli.group()
    def session():
        """Manage tmux sessions inside a sandbox."""
        pass

    @session.command("create")
    @click.argument("session_id")
    @click.option("--namespace", "-n", default=None)
    def session_create(session_id, namespace):
        """Create a tmux session in a sandbox."""
        ns = namespace or get_config_value("namespace", "default")
        dp = get_dp_client(session_id, namespace=ns)
        terminal_id = dp.session_create()
        print(f"Terminal ID: {terminal_id}")

    @session.command("exec")
    @click.argument("session_id")
    @click.argument("terminal_id")
    @click.argument("command")
    @click.option("--timeout", default="30s")
    @click.option("--working-dir", "-w", default="", help="Working directory for this command")
    def session_exec(session_id, terminal_id, command, timeout, working_dir):
        """Execute a command in a tmux session (stateful: cwd/env persist)."""
        dp = get_dp_client(session_id)
        result = dp.session_exec(terminal_id, command, timeout=timeout, working_dir=working_dir)
        print(result.get("output", ""))

    @session.command("output")
    @click.argument("session_id")
    @click.argument("terminal_id")
    def session_output(session_id, terminal_id):
        """Get current output from a tmux session pane."""
        dp = get_dp_client(session_id)
        output = dp.session_output(terminal_id)
        print(output)

    @session.command("delete")
    @click.argument("session_id")
    @click.argument("terminal_id")
    def session_delete(session_id, terminal_id):
        """Destroy a tmux session."""
        dp = get_dp_client(session_id)
        dp.session_delete(terminal_id)
        print(f"✅ Session {terminal_id} deleted")

    @session.command("send-keys")
    @click.argument("session_id")
    @click.argument("terminal_id")
    @click.argument("keys", nargs=-1)
    def session_send_keys(session_id, terminal_id, keys):
        """Send key sequences to a tmux session."""
        dp = get_dp_client(session_id)
        dp.send_keys(terminal_id, list(keys))
        print("✅ Keys sent")

    @session.command("screen")
    @click.argument("session_id")
    @click.argument("terminal_id")
    def session_screen(session_id, terminal_id):
        """Get current screen content of a tmux session."""
        dp = get_dp_client(session_id)
        result = dp.screen(terminal_id)
        print(result.get("content", ""))

    # ── files ──────────────────────────────────────────────────────────────

    @cli.group()
    def files():
        """File operations inside a sandbox."""
        pass

    @files.command("write")
    @click.argument("session_id")
    @click.argument("remote_path")
    @click.option("--content", "-c", default=None, help="Content string to write")
    @click.option("--file", "-f", "local_file", default=None, type=click.Path(exists=True),
                  help="Read content from a local file")
    @click.option("--stdin", "from_stdin", is_flag=True, default=False,
                  help="Read content from stdin")
    @click.option("--mode", default="0644", help="File permission mode (default: 0644)")
    def files_write(session_id, remote_path, content, local_file, from_stdin, mode):
        """Write content directly to a file in the sandbox.

        \b
        Examples:
            sandbox-cli files write <sid> /tmp/hello.txt -c "Hello World"
            sandbox-cli files write <sid> /tmp/script.py -f ./local_script.py
            echo "data" | sandbox-cli files write <sid> /tmp/data.txt --stdin
        """
        if local_file:
            with open(local_file, "rb") as f:
                data = f.read()
        elif from_stdin:
            data = sys.stdin.buffer.read()
        elif content is not None:
            data = content.encode("utf-8")
        else:
            print("ERROR: Provide content via --content, --file, or --stdin", file=sys.stderr)
            sys.exit(1)
        dp = get_dp_client(session_id)
        dp.file_write(remote_path, data, mode=mode)
        print(f"✅ Written {len(data)} bytes → {remote_path}")

    @files.command("read")
    @click.argument("session_id")
    @click.argument("remote_path")
    @click.option("--output", "-o", default=None, type=click.Path(),
                  help="Save to local file instead of printing to stdout")
    def files_read(session_id, remote_path, output):
        """Read a file from the sandbox and print to stdout (or save locally).

        \b
        Examples:
            sandbox-cli files read <sid> /tmp/output.txt
            sandbox-cli files read <sid> /tmp/data.bin -o ./data.bin
        """
        dp = get_dp_client(session_id)
        if output:
            dp.file_download(remote_path, output)
            print(f"✅ Downloaded {remote_path} → {output}", file=sys.stderr)
        else:
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                tmp_path = tmp.name
            try:
                dp.file_download(remote_path, tmp_path)
                with open(tmp_path, "r") as f:
                    print(f.read(), end="")
            finally:
                os.unlink(tmp_path)

    @files.command("delete")
    @click.argument("session_id")
    @click.argument("remote_path")
    def files_delete(session_id, remote_path):
        """Delete a file or directory in the sandbox."""
        dp = get_dp_client(session_id)
        dp.file_delete(remote_path)
        print(f"✅ Deleted {remote_path}")

    @files.command("upload")
    @click.argument("session_id")
    @click.argument("local_path")
    @click.argument("remote_path")
    def files_upload(session_id, local_path, remote_path):
        """Upload a local file to the sandbox."""
        dp = get_dp_client(session_id)
        dp.file_upload(local_path, remote_path)
        print(f"✅ Uploaded {local_path} → {remote_path}")

    @files.command("download")
    @click.argument("session_id")
    @click.argument("remote_path")
    @click.argument("local_path")
    def files_download(session_id, remote_path, local_path):
        """Download a file from the sandbox."""
        dp = get_dp_client(session_id)
        dp.file_download(remote_path, local_path)
        print(f"✅ Downloaded {remote_path} → {local_path}")

    @files.command("list")
    @click.argument("session_id")
    @click.argument("path", default=".")
    def files_list(session_id, path):
        """List files in the sandbox."""
        dp = get_dp_client(session_id)
        result = dp.file_list(path)
        for f in result:
            mode = f.get("mode", "")
            size = f.get("size", 0)
            name = f.get("name", "")
            is_dir = f.get("is_dir", False)
            suffix = "/" if is_dir else ""
            print(f"{mode}  {size:>10}  {name}{suffix}")

    # ── gpu ────────────────────────────────────────────────────────────────

    @cli.group()
    def gpu():
        """GPU status commands."""
        pass

    @gpu.command("status")
    @click.argument("session_id")
    def gpu_status(session_id):
        """Query GPU status in a sandbox."""
        dp = get_dp_client(session_id)
        result = dp.gpu_status()
        print(json.dumps(result, indent=2))

    # ── policy ─────────────────────────────────────────────────────────────

    @cli.group()
    def policy():
        """Manage runtime policy for an existing sandbox session."""
        pass

    @policy.command("get")
    @click.argument("session_id")
    def policy_get(session_id):
        """Get the effective runtime policy for a sandbox."""
        cp = get_cp_client()
        result = cp.get_policy(session_id)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    @policy.command("update")
    @click.argument("session_id")
    @click.option("--mode", "policy_mode", default=None, type=click.Choice(["enforce", "audit"]),
                  help="Policy mode")
    @click.option("--allow-egress", "allowed_egress", multiple=True,
                  help="Allow external domain (repeatable)")
    @click.option("--allow-internal", "allowed_internal", multiple=True,
                  help="Allow internal IP/CIDR (repeatable)")
    @click.option("--clear-egress", is_flag=True, default=False,
                  help="Clear allowedEgressHosts")
    @click.option("--clear-internal", is_flag=True, default=False,
                  help="Clear allowedInternalHosts")
    def policy_update(session_id, policy_mode, allowed_egress, allowed_internal, clear_egress, clear_internal):
        """Patch the runtime policy for a sandbox."""
        if clear_egress and allowed_egress:
            print("ERROR: --clear-egress cannot be used with --allow-egress", file=sys.stderr)
            sys.exit(1)
        if clear_internal and allowed_internal:
            print("ERROR: --clear-internal cannot be used with --allow-internal", file=sys.stderr)
            sys.exit(1)

        egress_hosts = [] if clear_egress else (list(allowed_egress) if allowed_egress else None)
        internal_hosts = [] if clear_internal else (list(allowed_internal) if allowed_internal else None)

        cp = get_cp_client()
        result = cp.update_policy(
            session_id,
            allowed_egress_hosts=egress_hosts,
            allowed_internal_hosts=internal_hosts,
            policy_mode=policy_mode,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    # ── template ────────────────────────────────────────────────────────────

    @cli.group()
    def template():
        """Manage CodeInterpreter templates (sandbox definitions)."""
        pass

    @template.command("create")
    @click.option("--file", "-f", "spec_file", required=True,
                  type=click.Path(exists=True), help="Path to JSON/YAML spec file")
    @click.option("--name", required=True, help="Template name (DNS-1035: e.g. python-311)")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    @click.option("--dockerfile", default=None, type=click.Path(exists=True),
                  help="Local Dockerfile to pre-build into the template image")
    @click.option("--public", is_flag=True, default=False,
                  help="Mark template as publicly visible/usable by all users (system-admin only)")
    @click.option("--stream", is_flag=True, default=False,
                  help="Stream build progress in real-time via SSE (useful for warmPoolSize > 0)")
    def template_create(spec_file, name, namespace, dockerfile, public, stream):
        """Create a new CodeInterpreter template from a JSON spec file.

        When warmPoolSize > 0, the server automatically validates the template by
        waiting for the first WarmPool Pod to start. The response includes build_log
        with per-phase diagnostics (image pull, build steps, etc.).

        Use --stream for real-time progress output (recommended for interactive use).

        \b
        Example spec file:
        {
          "template": {
            "fromImage": "python:3.11-slim",
            "steps": [{"type": "run", "args": ["pip install numpy -q"]}]
          },
          "warmPoolSize": 2,
          "sessionTimeout": "15m"
        }
        """
        import json as _json
        ns = namespace or get_config_value("namespace", "default")
        with open(spec_file) as f:
            content = f.read().strip()
        # Support both JSON and basic YAML (require pyyaml for YAML)
        if spec_file.endswith((".yaml", ".yml")):
            try:
                import yaml
                spec = yaml.safe_load(content)
            except ImportError:
                print("ERROR: Install pyyaml for YAML support: pip install pyyaml", file=sys.stderr)
                sys.exit(1)
        else:
            spec = _json.loads(content)
        dockerfile_content = None
        if dockerfile:
            with open(dockerfile) as f:
                dockerfile_content = f.read()

        cp = get_cp_client()

        if stream:
            # SSE streaming mode — show real-time progress
            print(f"Creating template '{name}'{' (public)' if public else ''}...", file=sys.stderr)
            for event in cp.create_template_stream(name, spec, namespace=ns, public=public, dockerfile=dockerfile_content):
                event_type = event.get("event", "")
                data = event.get("data", {})
                if event_type == "phase":
                    phase = data.get("phase", "")
                    status = data.get("status", "")
                    message = data.get("message", "")
                    duration = data.get("duration")
                    if status == "started":
                        print(f"⠋ {phase}: {message}", file=sys.stderr, end="\r")
                    elif status == "completed":
                        dur_str = f" ({duration:.1f}s)" if duration else ""
                        print(f"✓ {phase}{dur_str}    ", file=sys.stderr)
                    elif status == "failed":
                        dur_str = f" ({duration:.1f}s)" if duration else ""
                        print(f"✗ {phase}: {message}{dur_str}", file=sys.stderr)
                elif event_type == "log":
                    stdout = data.get("stdout", "")
                    if stdout:
                        print(f"  │ {stdout}", end="", file=sys.stderr)
                elif event_type == "end":
                    build_status = data.get("build_status", "unknown")
                    total_duration = data.get("total_duration")
                    dur_str = f" ({total_duration:.1f}s)" if total_duration else ""
                    if build_status == "ready":
                        print(f"\n✅ Template '{name}' created successfully{dur_str}", file=sys.stderr)
                    else:
                        err = data.get("error", "")
                        print(f"\n❌ Template build failed: {err}{dur_str}", file=sys.stderr)
                        sys.exit(1)
        else:
            # Synchronous mode — server blocks if warmPoolSize > 0, returns build_log
            result = cp.create_template(name, spec, namespace=ns, public=public, dockerfile=dockerfile_content)
            print(_json.dumps(result, indent=2, default=str))

            # Show build summary if available
            build_status = result.get("build_status")
            if build_status:
                build_duration = result.get("build_duration", 0)
                build_log = result.get("build_log", [])
                if build_status == "ready":
                    print(f"\n✅ Template '{name}' created in namespace '{ns}' ({build_duration:.1f}s)", file=sys.stderr)
                    for phase in build_log:
                        p = phase.get("phase", "")
                        s = phase.get("status", "")
                        d = phase.get("duration")
                        icon = "✓" if s == "completed" else "✗"
                        dur_str = f" ({d:.1f}s)" if d else ""
                        print(f"  {icon} {p}{dur_str}", file=sys.stderr)
                else:
                    error = result.get("error", "")
                    print(f"\n❌ Template build failed: {error}", file=sys.stderr)
                    for phase in build_log:
                        p = phase.get("phase", "")
                        s = phase.get("status", "")
                        d = phase.get("duration")
                        icon = "✓" if s == "completed" else "✗"
                        dur_str = f" ({d:.1f}s)" if d else ""
                        msg = phase.get("message", "")
                        stderr_out = phase.get("stderr", "")
                        print(f"  {icon} {p}{dur_str}", file=sys.stderr)
                        if msg:
                            print(f"    {msg}", file=sys.stderr)
                        if stderr_out:
                            print(f"    {stderr_out}", file=sys.stderr)
                    sys.exit(1)
            else:
                print(f"\n✅ Template '{name}' created in namespace '{ns}'", file=sys.stderr)

    @template.command("list")
    @click.option("--namespace", "-n", default=None, help="K8s namespace (empty = all)")
    @click.option("--all-namespaces", "-A", is_flag=True, default=False, help="List across all namespaces")
    @click.option("--user-id", default=None, help="Filter by creator user ID (exact match)")
    @click.option("--user-name", default=None, help="Filter by creator username (fuzzy match)")
    @click.option("--name", "filter_name", default=None, help="Filter by template name (fuzzy match)")
    @click.option("--public", "public_filter", default=None, type=click.Choice(["true", "false"]),
                  help="Filter by public status: true (only public), false (only private)")
    @click.option("--limit", default=100, type=int, help="Items per page")
    @click.option("--offset", default=0, type=int, help="Pagination offset")
    @click.option("--sort-by", default="createdAt", help="Sort field: createdAt, name")
    @click.option("--order", default="desc", help="Sort order: desc, asc")
    def template_list(namespace, all_namespaces, user_id, user_name, filter_name,
                      public_filter, limit, offset, sort_by, order):
        """List CodeInterpreter templates.

        Permission: default users see only own + public templates; admin roles see all.
        """
        if all_namespaces:
            ns = ""
        else:
            ns = namespace or get_config_value("namespace", "default")
        cp = get_cp_client()
        kwargs = {"namespace": ns, "limit": limit, "offset": offset, "sortBy": sort_by, "order": order}
        if user_id:
            kwargs["userId"] = user_id
        if user_name:
            kwargs["userName"] = user_name
        if filter_name:
            kwargs["name"] = filter_name
        if public_filter:
            kwargs["public"] = public_filter
        result = cp.list_templates(**kwargs)
        items = result.get("items", [])
        total = result.get("totalCount", len(items))
        if not items:
            print("No templates found.")
            return
        # Table output
        print(f"{'NAMESPACE':<15} {'NAME':<28} {'READY':<7} {'PUBLIC':<8} {'WARMPOOL':<10} {'CREATOR':<20} {'AGE'}")
        for item in items:
            meta = item.get("metadata", {})
            spec = item.get("spec", {})
            status = item.get("status", {})
            labels = meta.get("labels", {})
            annotations = meta.get("annotations", {})
            ns_col = meta.get("namespace", "-")
            name_col = meta.get("name", "-")
            ready = "✅" if status.get("ready") else "❌"
            is_public = "🌐" if labels.get("runtime.agent-sandbox.io/public") == "true" else "🔒"
            warm = spec.get("warmPoolSize", 0)
            creator = annotations.get("runtime.agent-sandbox.io/user.name", "-")[:18]
            created = meta.get("creationTimestamp", "-")
            print(f"{ns_col:<15} {name_col:<28} {ready:<7} {is_public:<8} {warm:<10} {creator:<20} {created}")
        print(f"\nTotal: {total}")

    @template.command("get")
    @click.argument("name")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    def template_get(name, namespace):
        """Get details of a single CodeInterpreter template."""
        ns = namespace or get_config_value("namespace", "default")
        cp = get_cp_client()
        result = cp.get_template(name, namespace=ns)
        print(json.dumps(result, indent=2, default=str))

    @template.command("update")
    @click.argument("name")
    @click.option("--file", "-f", "spec_file", required=True,
                  type=click.Path(exists=True), help="Path to JSON spec file with new spec")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    @click.option("--public/--no-public", default=None,
                  help="Change template public visibility (system-admin only)")
    def template_update(name, spec_file, namespace, public):
        """Update a CodeInterpreter template's spec from a JSON file.

        Use --public to make the template publicly visible, or --no-public to
        make it private. Only system-admin can change public status.
        """
        import json as _json
        ns = namespace or get_config_value("namespace", "default")
        with open(spec_file) as f:
            content = f.read().strip()
        if spec_file.endswith((".yaml", ".yml")):
            try:
                import yaml
                spec = yaml.safe_load(content)
            except ImportError:
                print("ERROR: Install pyyaml for YAML support: pip install pyyaml", file=sys.stderr)
                sys.exit(1)
        else:
            spec = _json.loads(content)
        cp = get_cp_client()
        result = cp.update_template(name, spec, namespace=ns, public=public)
        print(_json.dumps(result, indent=2, default=str))
        visibility_msg = ""
        if public is True:
            visibility_msg = " (set to public)"
        elif public is False:
            visibility_msg = " (set to private)"
        print(f"✅ Template '{name}' updated{visibility_msg}", file=sys.stderr)

    @template.command("delete")
    @click.argument("name")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    @click.option("--yes", "-y", is_flag=True, help="Skip confirmation prompt")
    def template_delete(name, namespace, yes):
        """Delete a CodeInterpreter template.

        WARNING: This removes the template definition. Existing sandboxes created
        from this template will continue running until they expire or are deleted.
        New sandboxes cannot be created from a deleted template.
        """
        ns = namespace or get_config_value("namespace", "default")
        if not yes:
            click.confirm(
                f"Delete template '{name}' in namespace '{ns}'? "
                "Existing sandboxes are unaffected.",
                abort=True,
            )
        cp = get_cp_client()
        ok = cp.delete_template(name, namespace=ns)
        if ok:
            print(f"✅ Template '{name}' deleted from namespace '{ns}'")
        else:
            print(f"❌ Failed to delete template '{name}'", file=sys.stderr)
            sys.exit(1)

    # ── forward (port forwarding) ─────────────────────────────────────────

    @cli.command("forward")
    @click.argument("session_id")
    @click.argument("ports")
    @click.option("--namespace", "-n", default=None, help="K8s namespace")
    def forward_ports(session_id, ports, namespace):
        """Forward a local port to a sandbox port.

        \b
        PORTS format: LOCAL_PORT:REMOTE_PORT
        Examples:
            sandbox-cli forward <session-id> 8000:8000
            sandbox-cli forward <session-id> 3000:8080
        """
        parts = ports.split(":")
        if len(parts) != 2:
            print("ERROR: PORTS must be LOCAL_PORT:REMOTE_PORT (e.g. 8000:8000)",
                  file=sys.stderr)
            sys.exit(1)
        try:
            local_port = int(parts[0])
            remote_port = int(parts[1])
        except ValueError:
            print("ERROR: ports must be integers", file=sys.stderr)
            sys.exit(1)

        ns = namespace or get_config_value("namespace", "default")
        dp = get_dp_client(session_id, namespace=ns)

        try:
            import websockets  # noqa: F401
        except ImportError:
            print("ERROR: websockets is required for port forwarding.\n"
                  "Install: pip install websockets>=12.0",
                  file=sys.stderr)
            sys.exit(1)

        from agent_sandbox.sandbox import PortForward

        with PortForward(dp, remote_port, local_port) as pf:
            print(f"Forwarding localhost:{pf.local_port} → sandbox:{remote_port}")
            print("Press Ctrl+C to stop")
            import threading
            stop_event = threading.Event()
            try:
                stop_event.wait()
            except KeyboardInterrupt:
                pass
            print("\nStopped")

    # ── health ─────────────────────────────────────────────────────────────

    @cli.command("health")
    def health_check():
        """Check service health."""
        cp = get_cp_client()
        result = cp.health()
        print(json.dumps(result, indent=2))

    def main():
        cli()

else:
    # Minimal argparse fallback when click is not installed
    import argparse

    def main():
        parser = argparse.ArgumentParser(description="sandbox-cli — agent-sandbox CLI tool")
        parser.add_argument("command", choices=["config", "sandbox", "files", "gpu"],
                            help="Command group")
        args, rest = parser.parse_known_args()
        print("Install 'click' for full CLI support: pip install click")
        print(f"Command: {args.command} {' '.join(rest)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
