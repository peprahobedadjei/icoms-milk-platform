# ICOMS — Milk Powder Classification Platform

Multi-tenant web platform for user-testing the powder-milk quality classifier.
See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) for the full design.

## Structure

```
web-platform/
├── frontend/     Next.js app (login + admin console)   → Vercel project #1
├── backend/      FastAPI inference (onnxruntime)        → Vercel project #2
├── firestore.rules   Firestore security rules
└── SYSTEM_DESIGN.md
```

## What's built so far (Phase 1–2)

- **Login page** — email/password, with an admin bootstrap path.
- **Admin console** — Overview, Organisations (CRUD), Models (register / rename /
  describe / assign to orgs), Invitations (auto-generate credentials + EmailJS).
- **Backend** — `/health` and `/predict` (image → prediction + confidence + Grad-CAM).
- **User workspace** — placeholder (built in the next phase).

## Run the frontend (admin console)

```powershell
cd web-platform\frontend
npm install
npm run dev        # http://localhost:3000  → redirects to /login
```

`frontend/.env.local` holds the config:
- `NEXT_PUBLIC_BOOTSTRAP_ADMIN_EMAIL` — the one email allowed to self-create the
  first admin account from the login page.
- `NEXT_PUBLIC_EMAILJS_*` — leave blank to have the dashboard show generated
  credentials for manual sending; fill in to send invite emails automatically.
- `NEXT_PUBLIC_BACKEND_URL` — the inference backend URL.

### First-time admin login

1. Start the frontend, open `/login`.
2. Enter the **bootstrap admin email** (from `.env.local`) and any password you
   choose → the admin account is created and you land in `/admin`.
3. From then on, log in normally.

## Run the backend

See [backend/run_local.md](./backend/run_local.md).

## Firebase setup checklist

1. In the Firebase console (project `icoms-v2`):
   - **Authentication** → enable **Email/Password**.
   - **Firestore** → create database (production mode).
   - Paste [firestore.rules](./firestore.rules) into Firestore → Rules → Publish.
2. That's it — the web config is already wired in `frontend/lib/firebase.ts`.

## Next phases

3. User workspace (org-scoped model picker + prediction UI).
4. GitHub Actions conversion pipeline (.pth → fp16 ONNX → Releases → Firestore).
5. Deploy: two Vercel projects + env vars + EmailJS keys.
