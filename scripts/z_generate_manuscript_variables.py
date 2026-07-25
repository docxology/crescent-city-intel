#!/usr/bin/env python3
"""Template-renderer adapter for the Bun manuscript hydrator."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    return subprocess.run(["bun", "run", "scripts/hydrate-manuscript.ts", *sys.argv[1:]], cwd=ROOT, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
