"""Milk powder classification — inference backend (Vercel Python function).

Runs the fp16 ONNX models validated in ResearchAssistant/onnx_pytorch.
The ONNX graph outputs (logits, cams); for ResNet-50 the CAM equals Grad-CAM on
layer4. No PyTorch is used here — inference is onnxruntime only, so the bundle
stays well under Vercel's 250 MB limit.

Endpoints:
  GET  /health           -> liveness + which models are cached
  POST /predict          -> multipart image + (model_url | model_file),
                            returns prediction, probabilities, PNG preview,
                            and a Grad-CAM jet overlay PNG.
"""

import base64
import hashlib
import io
import os
import time
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image

CLASS_NAMES = ["good", "poor"]
NUM_CLASSES = 2
IMG_SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Cache downloaded models here. On Vercel /tmp is writable (~500 MB, ephemeral).
CACHE_DIR = Path(os.environ.get("MODEL_CACHE_DIR", "/tmp/milk_models"))
try:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    # Windows / local dev: /tmp is not writable — fall back to a local folder.
    CACHE_DIR = Path("./_model_cache")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Optional: a local models directory for development (checked before download).
LOCAL_MODELS_DIR = Path(os.environ.get("LOCAL_MODELS_DIR", "")) if os.environ.get("LOCAL_MODELS_DIR") else None

# Allowlist of hosts we will download model files from (defence-in-depth:
# the URL comes from Firestore, written only by admins, but we still constrain it).
ALLOWED_MODEL_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
}

# Conversion-trigger config (set as backend env vars on Vercel).
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "peprahobedadjei/icoms-milk-platform")
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "icoms-v2")
WORKFLOW_FILE = os.environ.get("CONVERT_WORKFLOW", "convert-models.yml")

app = FastAPI(title="Milk Powder Classification — Inference")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to the frontend origin in production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_sessions: dict[str, ort.InferenceSession] = {}


# ----------------------------------------------------------------- model load

def _host_allowed(url: str) -> bool:
    from urllib.parse import urlparse

    host = urlparse(url).hostname or ""
    return host in ALLOWED_MODEL_HOSTS


def _cache_path_for(key: str) -> Path:
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    return CACHE_DIR / f"{digest}.onnx"


def _get_session(model_url: Optional[str], model_file: Optional[str]) -> ort.InferenceSession:
    """Return a cached ORT session, fetching/loading the model if needed."""
    if model_file:
        # local development: a bare filename served from LOCAL_MODELS_DIR
        if not LOCAL_MODELS_DIR:
            raise HTTPException(400, "model_file supplied but LOCAL_MODELS_DIR is not set")
        path = (LOCAL_MODELS_DIR / model_file).resolve()
        if not path.is_relative_to(LOCAL_MODELS_DIR.resolve()) or not path.exists():
            raise HTTPException(404, f"Local model not found: {model_file}")
        key = f"local:{path}"
        if key not in _sessions:
            _sessions[key] = ort.InferenceSession(str(path))
        return _sessions[key]

    if not model_url:
        raise HTTPException(400, "Provide model_url (or model_file for local dev)")
    if not _host_allowed(model_url):
        raise HTTPException(400, "model_url host is not allowed")

    if model_url in _sessions:
        return _sessions[model_url]

    cache = _cache_path_for(model_url)
    if not cache.exists():
        try:
            with httpx.Client(follow_redirects=True, timeout=30.0) as client:
                resp = client.get(model_url)
                resp.raise_for_status()
                cache.write_bytes(resp.content)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"Could not download model: {e}")

    _sessions[model_url] = ort.InferenceSession(str(cache))
    return _sessions[model_url]


# ----------------------------------------------------------------- imaging

def preprocess(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    rgb = img.convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    disp = np.asarray(rgb, dtype=np.float32) / 255.0
    x = (disp - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32), disp


def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max())
    return e / e.sum()


def normalize_cam(cam: np.ndarray) -> np.ndarray:
    cam = np.maximum(cam, 0.0)
    rng = cam.max() - cam.min()
    if rng < 1e-12:
        return np.zeros_like(cam, dtype=np.float32)
    return ((cam - cam.min()) / rng).astype(np.float32)


def _resize_bilinear(arr: np.ndarray, size: int) -> np.ndarray:
    """Resize a 2-D float map to (size,size) via PIL (no cv2 dependency)."""
    im = Image.fromarray(np.uint8(255 * np.clip(arr, 0, 1)))
    im = im.resize((size, size), Image.BILINEAR)
    return np.asarray(im, dtype=np.float32) / 255.0


def jet_colormap(gray: np.ndarray) -> np.ndarray:
    """Map a [0,1] map to an RGB jet image in [0,1] (matches cv2 COLORMAP_JET closely)."""
    x = np.clip(gray, 0.0, 1.0)
    four = 4.0 * x
    r = np.clip(np.minimum(four - 1.5, -four + 4.5), 0, 1)
    g = np.clip(np.minimum(four - 0.5, -four + 3.5), 0, 1)
    b = np.clip(np.minimum(four + 0.5, -four + 2.5), 0, 1)
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def cam_overlay_png(cam7: np.ndarray, disp_rgb: np.ndarray) -> str:
    cam = normalize_cam(cam7)
    cam_up = normalize_cam(_resize_bilinear(cam, IMG_SIZE))
    heat = jet_colormap(cam_up)
    overlay = 0.5 * heat + 0.5 * disp_rgb
    overlay = overlay / max(overlay.max(), 1e-6)
    return _png_b64(np.uint8(255 * overlay))


def _png_b64(rgb_uint8: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgb_uint8).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# ----------------------------------------------------------------- routes

@app.get("/health")
def health():
    return {
        "status": "ok",
        "cached_models": len(_sessions),
        "cache_dir": str(CACHE_DIR),
        "classes": CLASS_NAMES,
    }


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    model_url: Optional[str] = Form(None),
    model_file: Optional[str] = Form(None),
):
    session = _get_session(model_url, model_file)

    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception:
        raise HTTPException(400, "Could not read the uploaded file as an image")

    x, disp = preprocess(img)

    t0 = time.perf_counter()
    logits, cams = session.run(None, {"input": x})
    ms = (time.perf_counter() - t0) * 1000

    logits = np.asarray(logits, dtype=np.float32)[0]
    cams = np.asarray(cams, dtype=np.float32)
    pred = int(np.argmax(logits))
    probs = softmax(logits)

    return JSONResponse({
        "prediction": CLASS_NAMES[pred],
        "pred_index": pred,
        "probs": {CLASS_NAMES[i]: float(probs[i]) for i in range(NUM_CLASSES)},
        "confidence": float(probs[pred]),
        "time_ms": round(ms, 1),
        "preview_png": _png_b64(np.uint8(255 * disp)),
        "gradcam_png": cam_overlay_png(cams[0, pred], disp),
    })


# ----------------------------------------------------------------- convert trigger

async def _require_admin(id_token: str, uid: str, client: httpx.AsyncClient) -> None:
    """Verify the caller is an admin by reading their own user doc with their
    Firebase ID token (Firestore validates the token and enforces the read rule).
    """
    if not id_token or not uid:
        raise HTTPException(401, "Missing credentials")
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/users/{uid}"
    )
    r = await client.get(url, headers={"Authorization": f"Bearer {id_token}"})
    if r.status_code == 401:
        raise HTTPException(401, "Invalid or expired session")
    if r.status_code != 200:
        raise HTTPException(403, "Could not verify your account")
    role = r.json().get("fields", {}).get("role", {}).get("stringValue")
    if role != "admin":
        raise HTTPException(403, "Admin privileges required")


@app.post("/trigger-conversion")
async def trigger_conversion(payload: dict):
    id_token = payload.get("idToken")
    uid = payload.get("uid")
    drive_link = (payload.get("drive_link") or "").strip()
    force = bool(payload.get("force", False))

    if not drive_link:
        raise HTTPException(400, "A Google Drive link is required")
    if not GITHUB_TOKEN:
        raise HTTPException(500, "Server is not configured to trigger conversions (missing GITHUB_TOKEN)")

    async with httpx.AsyncClient(timeout=20.0) as client:
        await _require_admin(id_token, uid, client)

        gh = await client.post(
            f"https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/{WORKFLOW_FILE}/dispatches",
            headers={
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            json={"ref": "main", "inputs": {"drive_link": drive_link, "force": force}},
        )
        if gh.status_code not in (201, 204):
            raise HTTPException(502, f"GitHub trigger failed ({gh.status_code}): {gh.text[:200]}")

    return {
        "status": "triggered",
        "message": "Conversion started. Models appear here once the run finishes (a few minutes).",
        "actions_url": f"https://github.com/{GITHUB_REPO}/actions/workflows/{WORKFLOW_FILE}",
    }


_GH_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


@app.post("/conversion-status")
async def conversion_status(payload: dict):
    """Return the latest conversion run's steps + status, for live progress."""
    id_token = payload.get("idToken")
    uid = payload.get("uid")
    if not GITHUB_TOKEN:
        raise HTTPException(500, "Server is not configured (missing GITHUB_TOKEN)")

    headers = {"Authorization": f"Bearer {GITHUB_TOKEN}", **_GH_HEADERS}
    async with httpx.AsyncClient(timeout=20.0) as client:
        await _require_admin(id_token, uid, client)

        runs = await client.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/{WORKFLOW_FILE}/runs",
            headers=headers,
            params={"per_page": 1},
        )
        if runs.status_code != 200:
            raise HTTPException(502, f"Could not read runs ({runs.status_code})")
        run_list = runs.json().get("workflow_runs", [])
        if not run_list:
            return {"found": False}
        run = run_list[0]

        jobs = await client.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/actions/runs/{run['id']}/jobs",
            headers=headers,
        )
        steps = []
        if jobs.status_code == 200:
            for job in jobs.json().get("jobs", []):
                for s in job.get("steps", []):
                    steps.append({
                        "name": s.get("name"),
                        "status": s.get("status"),        # queued | in_progress | completed
                        "conclusion": s.get("conclusion"),  # success | failure | skipped | null
                    })

        return {
            "found": True,
            "run_id": run["id"],
            "status": run["status"],
            "conclusion": run.get("conclusion"),
            "html_url": run["html_url"],
            "created_at": run.get("created_at"),
            "steps": steps,
        }
