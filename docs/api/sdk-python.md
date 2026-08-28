# agent-sandbox SDK (`agent_sandbox`)

Python SDK and CLI for agent-sandbox, the sandboxed code-execution layer.
Source: `sandbox/sdk-python`. Note that this distribution is Apache-2.0, unlike
the MIT-licensed remainder of the repository — see `sandbox/LICENSE`.

## `agent_sandbox`

The top-level package and `agent_sandbox.clients` are re-export shims, so their
members are documented on the defining submodules below rather than duplicated
here.

```{eval-rst}
.. automodule:: agent_sandbox
   :no-members:
```

### Sandbox and session

```{eval-rst}
.. automodule:: agent_sandbox.sandbox

.. automodule:: agent_sandbox.session
```

### Files

```{eval-rst}
.. automodule:: agent_sandbox.files
```

### Clients

```{eval-rst}
.. automodule:: agent_sandbox.clients
   :no-members:

.. automodule:: agent_sandbox.clients.control_plane

.. automodule:: agent_sandbox.clients.data_plane
```

### Exceptions

```{eval-rst}
.. automodule:: agent_sandbox.exceptions
```

## `sandbox_cli`

```{eval-rst}
.. automodule:: sandbox_cli

.. automodule:: sandbox_cli.main
```
