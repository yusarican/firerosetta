"""Device selection for every training step in this project.

One place decides where training runs, so `python -m firerosetta.<step>` picks the GPU
automatically when there is one and still works on a laptop without CUDA.

Honest scope of the acceleration:

  * `static.py` trains a torch autoencoder -> genuinely runs on the GPU.
  * `harmonize.py` / `forecast.py` use scikit-learn's HistGradientBoosting, which has **no**
    CUDA path at all. Nothing here can change that; they stay on CPU by design and say so.
    Their inputs (2e5 rows) are small enough that the GPU would lose to PCIe transfer anyway.

So "CUDA enabled" means: the deep model trains on the GPU, and `require`/`describe` give the
other steps a single honest answer about what hardware they are on.

    uv run --extra gpu python -m firerosetta.gpu    # print what this machine offers
"""
from __future__ import annotations

import os
import shutil
import subprocess

# FIREROSETTA_DEVICE=cpu forces CPU even with a working GPU (useful for a reproducibility check,
# since cuDNN kernels are not bit-identical to the CPU ones).
_FORCE = os.environ.get("FIREROSETTA_DEVICE", "").strip().lower()


def torch_or_none():
    """Import torch, or None when the optional `gpu` extra was never installed."""
    try:
        import torch
    except ImportError:
        return None
    return torch


def pick_device() -> tuple[str, str]:
    """Return (device, reason). Never raises: callers may legitimately have no GPU."""
    torch = torch_or_none()
    if torch is None:
        return "cpu", "torch not installed (uv sync --extra gpu)"
    if _FORCE in {"cpu", "cuda"}:
        if _FORCE == "cuda" and not torch.cuda.is_available():
            return "cpu", "FIREROSETTA_DEVICE=cuda requested but no CUDA device is visible"
        return _FORCE, f"FIREROSETTA_DEVICE={_FORCE}"
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        total = torch.cuda.mem_get_info()[1] / 1e9
        return "cuda", f"{name}, {total:.1f} GB, CUDA {torch.version.cuda}"
    if not shutil.which("nvidia-smi"):
        return "cpu", "no NVIDIA driver found"
    return "cpu", "driver present but torch sees no CUDA device (wrong wheel? try --extra gpu)"


def require(label: str) -> str:
    """Resolve the device for a training step and print the choice.

    Training silently falling back to CPU is the kind of thing you only notice in the
    wall-clock time, so every step announces what it got.
    """
    device, reason = pick_device()
    mark = "CUDA" if device == "cuda" else "CPU "
    print(f"[{mark}] {label}: {reason}")
    return device


def seed_all(seed: int = 0) -> None:
    """Make a run repeatable: python, numpy and (if present) torch on both devices."""
    import random

    import numpy as np

    random.seed(seed)
    np.random.seed(seed)
    torch = torch_or_none()
    if torch is not None:
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        # cuDNN picks algorithms by benchmarking, which makes results vary run to run
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True


def describe() -> dict:
    """Hardware/software provenance to store beside a trained model."""
    device, reason = pick_device()
    torch = torch_or_none()
    out = {"device": device, "reason": reason,
           "torch": getattr(torch, "__version__", None),
           "cuda_build": getattr(getattr(torch, "version", None), "cuda", None)}
    if device == "cuda" and torch is not None:
        out["gpu"] = torch.cuda.get_device_name(0)
        out["capability"] = "sm_%d%d" % torch.cuda.get_device_capability(0)
    return out


def main() -> None:
    device, reason = pick_device()
    print(f"device: {device}\nreason: {reason}")
    torch = torch_or_none()
    if torch is None:
        print("\ntorch is optional and missing. Install it with:\n"
              "  cd backend && uv sync --extra gpu")
        return
    print(f"torch:  {torch.__version__} (built against CUDA {torch.version.cuda})")
    if device != "cuda":
        if shutil.which("nvidia-smi"):
            print("\nnvidia-smi says:", flush=True)  # else the child's output lands first
            subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total",
                            "--format=csv,noheader"], check=False)
        return

    import time

    a = torch.randn(4096, 4096, device="cuda")
    for _ in range(3):  # warm up: the first call pays for context creation and autotuning
        a @ a
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(20):
        a @ a
    torch.cuda.synchronize()
    dt = time.perf_counter() - t
    print(f"check:  {20 * 2 * 4096 ** 3 / dt / 1e12:.1f} TFLOP/s fp32 (4096^3 matmul)")


if __name__ == "__main__":
    main()
