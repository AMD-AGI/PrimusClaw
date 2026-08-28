# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

import uvicorn
import os

def run():
    port = int(os.environ.get("MEMORY_SERVICE_PORT", "8765"))
    host = os.environ.get("MEMORY_SERVICE_HOST", "0.0.0.0")
    uvicorn.run("claw_memory.storage.app:app", host=host, port=port, log_level="info")

if __name__ == "__main__":
    run()
