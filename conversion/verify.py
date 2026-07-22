"""Fidelity gate: prove an fp16 ONNX export matches its PyTorch checkpoint.

Uses deterministic random inputs (no external image dataset needed in CI) to check:
  - prediction agreement (PyTorch vs ONNX Runtime)
  - max absolute logit difference
  - the baked-in CAM vs true autograd Grad-CAM on layer4

fp16 introduces tiny numeric drift; thresholds allow that but catch any real break.
Returns a dict; `passed` is the go/no-go signal for publishing.
"""

import numpy as np
import onnxruntime as ort
import torch

from model_common import IMG_SIZE, ResNet50WithCAM

# fp16 tolerances (validated: fp16 kept 106/106 agreement, ~4e-4 logit drift)
MAX_LOGIT_DIFF = 5e-2
MAX_CAM_DIFF = 1e-1


def _normalize(cam: np.ndarray) -> np.ndarray:
    cam = np.maximum(cam, 0.0)
    rng = cam.max() - cam.min()
    if rng < 1e-12:
        return np.zeros_like(cam, dtype=np.float32)
    return ((cam - cam.min()) / rng).astype(np.float32)


def _autograd_gradcam(resnet, x: torch.Tensor, target: int) -> np.ndarray:
    feats = {}

    def hook(_m, _i, out):
        feats["a"] = out
        out.retain_grad()

    h = resnet.layer4.register_forward_hook(hook)
    resnet.zero_grad()
    logits = resnet(x)
    logits[0, target].backward()
    h.remove()
    a = feats["a"]
    w = a.grad.mean(dim=(2, 3), keepdim=True)
    cam = (w * a).sum(dim=1)[0].detach().numpy()
    return _normalize(cam)


def fidelity_check(resnet, wrapped: ResNet50WithCAM, onnx_path: str, n: int = 16) -> dict:
    sess = ort.InferenceSession(onnx_path)
    rng = np.random.default_rng(42)

    agree = 0
    max_logit_diff = 0.0
    max_cam_diff = 0.0
    for _ in range(n):
        x_np = rng.standard_normal((1, 3, IMG_SIZE, IMG_SIZE)).astype(np.float32)
        xt = torch.from_numpy(x_np)
        with torch.no_grad():
            t_logits, _ = wrapped(xt)
        o_logits, o_cams = sess.run(None, {"input": x_np})
        o_logits = np.asarray(o_logits, dtype=np.float32)

        t_pred = int(t_logits.argmax())
        o_pred = int(np.argmax(o_logits[0]))
        agree += int(t_pred == o_pred)
        max_logit_diff = max(max_logit_diff, float(np.abs(t_logits.numpy() - o_logits).max()))

        ref = _autograd_gradcam(resnet, xt, o_pred)
        onnx_cam = _normalize(np.asarray(o_cams, dtype=np.float32)[0, o_pred])
        max_cam_diff = max(max_cam_diff, float(np.abs(ref - onnx_cam).max()))

    passed = (agree == n) and (max_logit_diff < MAX_LOGIT_DIFF) and (max_cam_diff < MAX_CAM_DIFF)
    return {
        "passed": passed,
        "agreement": f"{agree}/{n}",
        "max_logit_diff": max_logit_diff,
        "max_cam_diff": max_cam_diff,
        "summary": f"PASS (agree {agree}/{n}, max|logit|={max_logit_diff:.2e})"
        if passed else
        f"FAIL (agree {agree}/{n}, max|logit|={max_logit_diff:.2e}, max|cam|={max_cam_diff:.2e})",
    }
