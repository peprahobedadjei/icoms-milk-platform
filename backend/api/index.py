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
import json
import os
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
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

# Email (Gmail SMTP via an App Password) — set as backend env vars on Vercel.
GMAIL_USER = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
GMAIL_FROM_NAME = os.environ.get("GMAIL_FROM_NAME", "ICOMS")

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


# ----------------------------------------------------------------- delete model

async def _firestore_delete(doc_id: str, id_token: str, client: httpx.AsyncClient) -> None:
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/models/{doc_id}"
    )
    r = await client.delete(url, headers={"Authorization": f"Bearer {id_token}"})
    if r.status_code not in (200, 204):
        raise HTTPException(502, f"Could not delete the model record ({r.status_code})")


@app.post("/delete-model")
async def delete_model(payload: dict):
    """Fully remove a model: Release asset + manifest checksum + Firestore doc.

    Models registered manually (no storage_file) are removed from Firestore only.
    """
    id_token = payload.get("idToken")
    uid = payload.get("uid")
    doc_id = (payload.get("docId") or "").strip()
    storage_file = (payload.get("storageFile") or "").strip()
    if not doc_id:
        raise HTTPException(400, "docId is required")

    async with httpx.AsyncClient(timeout=30.0) as client:
        await _require_admin(id_token, uid, client)

        removed_asset = False
        removed_from_manifest = False

        if storage_file:
            if not GITHUB_TOKEN:
                raise HTTPException(
                    500,
                    "Server is not configured to delete model files (missing GITHUB_TOKEN).",
                )
            headers = {"Authorization": f"Bearer {GITHUB_TOKEN}", **_GH_HEADERS}

            rel = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/models",
                headers=headers,
            )
            if rel.status_code == 200:
                release = rel.json()
                release_id = release["id"]
                assets = release.get("assets", [])
                onnx_asset = next((a for a in assets if a["name"] == storage_file), None)
                manifest_asset = next((a for a in assets if a["name"] == "manifest.json"), None)

                # 1. rewrite the manifest without this model's checksum
                if manifest_asset:
                    cur = await client.get(
                        manifest_asset["browser_download_url"], follow_redirects=True
                    )
                    if cur.status_code != 200:
                        raise HTTPException(
                            502, f"Could not read the current manifest ({cur.status_code})"
                        )
                    manifest = cur.json()
                    new_manifest = [e for e in manifest if e.get("storage_file") != storage_file]
                    removed_from_manifest = len(new_manifest) != len(manifest)

                    async def _upload_manifest(data: list) -> httpx.Response:
                        return await client.post(
                            f"https://uploads.github.com/repos/{GITHUB_REPO}/releases/{release_id}/assets",
                            headers={**headers, "Content-Type": "application/json"},
                            params={"name": "manifest.json"},
                            content=json.dumps(data, indent=2).encode(),
                        )

                    # GitHub can't overwrite an asset in place, so delete then re-upload.
                    dm = await client.delete(
                        f"https://api.github.com/repos/{GITHUB_REPO}/releases/assets/{manifest_asset['id']}",
                        headers=headers,
                    )
                    if dm.status_code not in (200, 204):
                        raise HTTPException(
                            502,
                            f"Could not update the manifest ({dm.status_code}). "
                            "The GitHub token likely needs 'Contents: Read and write'.",
                        )
                    up = await _upload_manifest(new_manifest)
                    if up.status_code not in (201, 200):
                        # restore the original so the manifest is never left missing
                        await _upload_manifest(manifest)
                        raise HTTPException(
                            502,
                            f"Could not update the manifest ({up.status_code}). "
                            "The GitHub token likely needs 'Contents: Read and write'.",
                        )

                # 2. delete the .onnx asset
                if onnx_asset:
                    d = await client.delete(
                        f"https://api.github.com/repos/{GITHUB_REPO}/releases/assets/{onnx_asset['id']}",
                        headers=headers,
                    )
                    removed_asset = d.status_code in (204, 200)

        # 3. delete the Firestore record (with the admin's own token)
        await _firestore_delete(doc_id, id_token, client)

    return {
        "status": "deleted",
        "asset_deleted": removed_asset,
        "manifest_updated": removed_from_manifest,
    }


# ----------------------------------------------------------------- invite email

def _invite_email_html(name: str, email: str, password: str, org: str,
                       role: str, login_url: str) -> str:
    role_label = "Administrator" if role == "admin" else "Tester"
    org_row = (
        f'<tr><td style="padding:4px 0;color:#8a6b7d;">Organisation</td>'
        f'<td style="padding:4px 0;font-weight:600;text-align:right;">{org}</td></tr>'
        if org else ""
    )
    return f"""\
<!doctype html>
<html><body style="margin:0;background:#faf7f8;font-family:'Segoe UI',Arial,sans-serif;color:#370627;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="max-width:560px;width:100%;background:#ffffff;border:1px solid #f0e4e9;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#cd0e34;padding:22px 32px;">
          <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:.5px;">ICOMS</span>
          <div style="color:#ffd9e1;font-size:13px;margin-top:2px;">Powder Milk Quality Assessment</div>
        </td></tr>

        <tr><td style="padding:30px 32px 8px;">
          <h1 style="margin:0 0 6px;font-size:21px;">Hi {name},</h1>
          <p style="margin:0;color:#6b5563;font-size:15px;line-height:1.6;">
            You've been invited to the ICOMS platform as a <strong>{role_label}</strong>.
            Use the credentials below to sign in.
          </p>
        </td></tr>

        <tr><td style="padding:18px 32px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:#faf7f8;border:1px solid #f0e4e9;border-radius:12px;padding:16px 18px;">
            <tr><td style="padding:4px 0;color:#8a6b7d;font-size:14px;">Name</td>
                <td style="padding:4px 0;font-weight:600;text-align:right;font-size:14px;">{name}</td></tr>
            {org_row}
            <tr><td style="padding:4px 0;color:#8a6b7d;font-size:14px;">Role</td>
                <td style="padding:4px 0;font-weight:600;text-align:right;font-size:14px;">{role_label}</td></tr>
            <tr><td style="padding:10px 0 4px;color:#8a6b7d;font-size:14px;">Email</td>
                <td style="padding:10px 0 4px;font-weight:600;text-align:right;font-size:14px;">{email}</td></tr>
            <tr><td style="padding:4px 0;color:#8a6b7d;font-size:14px;">Password</td>
                <td style="padding:4px 0;text-align:right;">
                  <code style="background:#fdeef1;color:#cd0e34;font-weight:700;padding:4px 10px;border-radius:6px;font-size:14px;">{password}</code>
                </td></tr>
          </table>
        </td></tr>

        <tr><td align="center" style="padding:22px 32px 6px;">
          <a href="{login_url}" style="display:inline-block;background:#cd0e34;color:#fff;text-decoration:none;
             font-weight:700;font-size:15px;padding:13px 34px;border-radius:10px;">Open ICOMS &amp; sign in</a>
          <div style="margin-top:10px;font-size:12px;color:#8a6b7d;">or paste this link: {login_url}</div>
        </td></tr>

        <tr><td style="padding:22px 32px 6px;">
          <h2 style="margin:0 0 10px;font-size:16px;">How to run an assessment</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="padding:6px 0;font-size:14px;line-height:1.5;">
              <strong style="color:#cd0e34;">1.</strong>&nbsp; Sign in with the credentials above.</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;line-height:1.5;">
              <strong style="color:#cd0e34;">2.</strong>&nbsp; Choose a model from the list.</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;line-height:1.5;">
              <strong style="color:#cd0e34;">3.</strong>&nbsp; Upload a microscopy image (<code>.tif</code>, <code>.jpg</code> or <code>.png</code>).</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;line-height:1.5;">
              <strong style="color:#cd0e34;">4.</strong>&nbsp; Read the result — a <strong>good / poor</strong> assessment with confidence,
              plus a Grad-CAM heat-map showing which regions the model focused on.</td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:20px 32px 30px;border-top:1px solid #f0e4e9;margin-top:10px;">
          <p style="margin:0;font-size:12.5px;color:#8a6b7d;line-height:1.6;">
            Keep these credentials private. If you didn't expect this invitation, you can ignore this email.
            Need help? Reply to this message and your administrator will assist.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def _invite_email_text(name: str, email: str, password: str, org: str,
                       role: str, login_url: str) -> str:
    role_label = "Administrator" if role == "admin" else "Tester"
    org_line = f"Organisation: {org}\n" if org else ""
    return (
        f"Hi {name},\n\n"
        f"You've been invited to the ICOMS Powder Milk Quality Assessment platform "
        f"as a {role_label}.\n\n"
        f"Sign in here: {login_url}\n\n"
        f"Your credentials\n"
        f"----------------\n"
        f"Name: {name}\n"
        f"{org_line}"
        f"Role: {role_label}\n"
        f"Email: {email}\n"
        f"Password: {password}\n\n"
        f"How to run an assessment\n"
        f"1. Sign in with the credentials above.\n"
        f"2. Choose a model from the list.\n"
        f"3. Upload a microscopy image (.tif, .jpg or .png).\n"
        f"4. Read the good/poor result with confidence and a Grad-CAM heat-map.\n\n"
        f"Keep these credentials private.\n"
    )


@app.post("/send-invite")
async def send_invite(payload: dict):
    id_token = payload.get("idToken")
    uid = payload.get("uid")
    to_email = (payload.get("to_email") or "").strip()
    to_name = (payload.get("to_name") or "").strip() or to_email
    org_name = (payload.get("org_name") or "").strip()
    role = payload.get("role") or "user"
    password = payload.get("password") or ""
    login_url = (payload.get("login_url") or "").strip()

    if not (to_email and password and login_url):
        raise HTTPException(400, "to_email, password and login_url are required")
    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        raise HTTPException(500, "Email is not configured (missing GMAIL_USER / GMAIL_APP_PASSWORD)")

    async with httpx.AsyncClient(timeout=20.0) as client:
        await _require_admin(id_token, uid, client)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Your ICOMS access — Powder Milk Quality Assessment"
    msg["From"] = f"{GMAIL_FROM_NAME} <{GMAIL_USER}>"
    msg["To"] = to_email
    msg.attach(MIMEText(_invite_email_text(to_name, to_email, password, org_name, role, login_url), "plain"))
    msg.attach(MIMEText(_invite_email_html(to_name, to_email, password, org_name, role, login_url), "html"))

    def _send():
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=20) as s:
            s.starttls()
            s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            s.sendmail(GMAIL_USER, [to_email], msg.as_string())

    try:
        await run_in_threadpool(_send)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Could not send the email: {e}")

    return {"status": "sent", "to": to_email}
