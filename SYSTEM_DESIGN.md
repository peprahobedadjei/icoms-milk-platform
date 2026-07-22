# Milk Powder Classification Platform — System Design

**Status:** in build · **Date:** 2026-07-21
**Owner:** Obed Peprah (ATU research) · Drafted with Claude

---

## 1. What we are building

A free-to-run web platform where invited testers evaluate the powder-milk quality
classifier (good vs poor) from the PhD research project. Admins manage models and
access; users log in, pick a model assigned to their organisation, upload a
milk-powder image, and get a prediction with confidence and a Grad-CAM heatmap.

### Why

- The 10-fold CV ResNet-50 models exist as PyTorch checkpoints (~92 MB each) in
  `cv_10fold/`. They must be usable by non-technical testers for user testing.
- Everything must run on free tiers, reliably, for a long period.
- Results served to testers must be **provably identical** to the validated
  research models (no silent accuracy drift from deployment).

### Non-goals (for now)

- 10-fold ensemble predictions per request (single selected model per prediction).
- Payments, production-scale traffic, mobile apps.

---

## 2. Validation already completed (foundation)

Built and tested in `ResearchAssistant/onnx_pytorch/` (FastAPI validator app):

| Variant | Size | Agreement with PyTorch (106 real images) | Max logit diff | Verdict |
|---------|------|------------------------------------------|----------------|---------|
| fp32    | 94 MB | 106/106 | 1.3e-06 | exact |
| **fp16** | **47 MB** | **106/106** | 3.7e-04 | **chosen for deployment** |
| int8    | 24 MB | 95/106 (11 flips) | 1.0e-01 | rejected |

- ONNX export includes a **baked-in CAM head**: the graph outputs `(logits, cams)`.
  For ResNet-50 (GAP → fc) this equals Grad-CAM on `layer4` (verified vs autograd
  to ~1e-6), so **no PyTorch is needed at inference time**.
- Class mapping: `good = 0`, `poor = 1`.
  Preprocessing: RGB → resize 224×224 (bilinear) → /255 → ImageNet normalize.

**Rule carried forward:** no converted model is published without passing the
fidelity check (PyTorch vs ONNX agreement on the reference image set).

---

## 3. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                GitHub repo                   │
 ADMIN                 │  GitHub Action (free CI):                    │
  │ paste Drive link   │  gdown .pth → convert to ONNX fp16 →         │
  ├───────────────────►│  fidelity check → publish to Releases →      │
  │                    │  update manifest.json + Firestore metadata   │
  │                    │  Releases hold: foldN_fp16.onnx, manifest    │
  │                    └───────────────────┬──────────────────────────┘
  │                                        │ model download (cached in /tmp)
  ▼                                        ▼
┌─────────────────────┐    ┌───────────────────────────┐
│ frontend/ (Next.js) │───►│ backend/ (Python FastAPI) │
│ Vercel project #1   │    │ Vercel project #2         │
│ login + dashboards  │    │ /predict → onnxruntime    │
└─────┬───────────────┘    │ returns logits + CAM      │
      │                    └───────────────────────────┘
      ▼
┌──────────────────────────────┐   ┌──────────────┐
│ Firebase: Auth + Firestore   │   │ EmailJS      │
│ users, roles, orgs, models,  │   │ credential   │
│ assignments, invitations     │   │ emails       │
└──────────────────────────────┘   └──────────────┘
```

### Stack (all free tiers)

| Concern | Service | Free-tier limits we rely on |
|---|---|---|
| Frontend hosting | Vercel Hobby (Next.js) | 100 GB bandwidth/mo; non-commercial |
| Inference backend | Vercel Hobby (Python function) | 250 MB bundle, 10 s exec, ~1 GB RAM |
| Auth + DB | Firebase Spark (project `icoms-v2`) | 50K reads / 20K writes per day |
| Invitation emails | EmailJS | 200 emails/mo |
| Model conversion | GitHub Actions | free minutes (public repo: unlimited) |
| ONNX model storage | GitHub Releases | 2 GB/file; 10 fp16 models ≈ 470 MB |
| .pth source inbox | Google Drive (existing) | fetched only by the Action via gdown |

**Why not X:** HF Spaces compute is PRO-gated; Google Drive as *serving* storage
is unreliable (interstitials/quotas) — it is only the conversion inbox; INT8
rejected on fidelity; PyTorch can never ship to Vercel (size).

---

## 4. Repository layout

```
web-platform/
├── SYSTEM_DESIGN.md            # this document
├── firestore.rules             # security rules (paste into Firebase console)
├── frontend/                   # Next.js → Vercel project #1
│   ├── app/
│   │   ├── login/              # shared login page ("Login as admin" beneath)
│   │   ├── admin/              # admin dashboard (role-gated)
│   │   │   ├── models/         #   list, rename, describe, assign orgs
│   │   │   ├── orgs/           #   organisations CRUD
│   │   │   └── invitations/    #   invite users (generated credentials + EmailJS)
│   │   └── workspace/          # user prediction UI (later phase)
│   └── lib/                    # firebase client, emailjs helper, types
├── backend/                    # Python FastAPI → Vercel project #2
│   ├── app.py                  # /predict, /health (onnxruntime + CAM, no torch)
│   └── requirements.txt
├── conversion/                 # runs only in CI, never deployed (later phase)
│   ├── convert.py              # .pth → ONNX fp16 (from validated engine.py)
│   └── verify.py               # fidelity gate
└── .github/workflows/
    └── convert-models.yml      # pipeline (workflow_dispatch, idempotent)
```

---

## 5. Design language (frontend)

- **Light theme**, white background, generous whitespace, card-based layout.
- **Font:** Sora (Google Fonts).
- **Primary/button colour:** `#cd0e34` · **Text colour:** `#370627`.
- Rounded corners, soft shadows, subtle borders — clean and sleek.

---

## 6. Data model (Firestore)

```
users/{uid}
  email, displayName, role: "admin" | "user", orgId, createdAt

orgs/{orgId}
  name, createdAt

models/{modelId}
  displayName        # human name, admin-editable (users only ever see this)
  description        # notes (training batch, metrics context)
  storageFile        # e.g. "fold11_fp16.onnx" — stable technical name
  downloadUrl        # GitHub Releases asset URL
  sha256             # checksum of the SOURCE .pth (audit trail)
  metrics            # { accuracy, f1 } when known
  fidelity           # "PASS (n/n)" from the CI gate
  orgIds: [ ... ]    # organisations allowed to use this model
  createdAt, updatedAt

invitations/{inviteId}
  email, orgId, role, status: "sent" | "accepted", sentAt
```

**Access rules (firestore.rules):** users read only models whose `orgIds` contain
their org; only admins write models/orgs/invitations; a user can read their own
user doc. The backend re-checks org membership on /predict (Firebase ID token).

---

## 7. Key flows

### 7.1 Login (everyone)

Single email + password form with **“Login as admin”** beneath. After sign-in the
app reads `users/{uid}`: role `admin` → `/admin`, role `user` → `/workspace`.
Bootstrap: the first admin account is created from the login page when the email
matches the configured bootstrap admin email (env var), then the flow is closed.

### 7.2 Admin: invite users (credentials by email)

1. Admin fills the invitation form: email, organisation, role.
2. The dashboard **generates a strong password**, creates the Firebase Auth user
   (via a secondary Firebase app instance so the admin stays signed in), and
   writes `users/{uid}` + `invitations/{id}`.
3. **EmailJS** sends the invite email containing the login URL + email + generated
   password. If EmailJS keys are not configured yet, the dashboard shows the
   credentials to copy/send manually (fallback).
4. The invited person logs in with those credentials and lands in their workspace,
   seeing only their organisation's models.

### 7.3 Admin: add/convert models (CI pipeline — later phase)

1. Admin puts `.pth` files in a Google Drive folder (file names become default
   display names) and pastes the folder link in the dashboard → triggers the
   GitHub Action.
2. The Action: gdown → SHA-256 each file → **skip checksums already in
   manifest.json** (adding an 11th file converts only that one; a same-named file
   with a new checksum counts as changed and is reconverted) → convert to fp16
   ONNX with CAM head → fidelity gate (FAIL = not published) → upload to
   Releases → update manifest + Firestore.
3. `force: true` input reconverts everything (only when export logic changes).
4. Admin renames models and assigns orgs in the dashboard (Firestore edits only —
   files are never touched by a rename).

### 7.4 User: predict (later phase)

Login → model picker (org-scoped, display names) → upload image → backend
(onnxruntime, model cached from Releases) → GOOD/POOR badge, confidence bars,
Grad-CAM jet overlay (client-side composite), PNG preview (browsers can't render
.tif). Optional: store prediction + "was this correct?" feedback in Firestore for
the user-testing study.

---

## 8. Known limitations (accepted)

- **Cold starts:** first prediction after idle downloads the model (~47 MB,
  1–3 s) plus boot; warm requests ~0.3 s.
- **Single model per prediction** (folds individually selectable, no ensemble).
- **EmailJS 200/mo** — invitations only.
- **Firestore free quotas** — generous for a user test; avoid chatty listeners.
- **Vercel Hobby is non-commercial** — academic user testing qualifies.
- Fold-1 fp16 observed 53.8% accuracy on the S10/S11 `Images/` set (vs 81.7% CV
  test accuracy) — a model-generalization observation, **not** a deployment bug
  (PyTorch and ONNX agree 106/106). Track during user testing.

---

## 9. Build plan

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Repo scaffold (frontend/, backend/, doc, rules) | **now** |
| 2 | **Admin**: login page + admin dashboard (orgs, models, invitations w/ EmailJS) + backend /health & /predict runnable locally | **now** |
| 3 | User workspace: org-scoped model picker + predict UI (Grad-CAM overlay) | next |
| 4 | Conversion pipeline: convert-models.yml + manifest idempotency + Firestore update | next |
| 5 | Deploy: two Vercel projects, Firestore rules, EmailJS keys, acceptance pass | next |

### Keys/accounts still needed from the owner

- EmailJS: service ID, template ID, public key (for real invite emails)
- GitHub repo (public recommended) — for Actions + Releases phases
- Vercel account — deploy phase
- Google Drive folder link with the .pth files — conversion phase

---

## 10. Fidelity principles (carried through everything)

1. Same preprocessing everywhere (backend mirrors the training eval transform).
2. fp16 ONNX only; INT8 is banned (validated: it changes predictions).
3. No model published without passing the CI fidelity gate.
4. SHA-256 of source .pth recorded in manifest + Firestore — full audit trail of
   which weights served which predictions, for the thesis.
