"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

// One or more emails allowed to self-create an admin account on first sign-in.
const BOOTSTRAP_ADMIN_EMAILS = (process.env.NEXT_PUBLIC_BOOTSTRAP_ADMIN_EMAIL ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function routeByRole(uid: string, signedInEmail: string) {
    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);
    let role = snap.exists() ? (snap.data().role as string) : null;

    // Self-heal: a bootstrap-admin email always gets an admin profile, even if a
    // previous attempt created the auth account but never wrote the role doc.
    if (BOOTSTRAP_ADMIN_EMAILS.includes(signedInEmail.trim().toLowerCase()) && role !== "admin") {
      try {
        const payload: Record<string, unknown> = {
          email: signedInEmail.trim().toLowerCase(),
          role: "admin",
          displayName: (snap.exists() && snap.data().displayName) || "Administrator",
        };
        if (!snap.exists()) payload.createdAt = serverTimestamp();
        await setDoc(ref, payload, { merge: true });
        role = "admin";
      } catch {
        /* keep whatever role we have and route accordingly */
      }
    }

    // deactivated (non-admin) accounts cannot enter
    const active = snap.exists() ? snap.data().active : true;
    if (role !== "admin" && active === false) {
      await signOut(auth);
      setError("Your account has been deactivated. Please contact your administrator.");
      setBusy(false);
      return;
    }

    if (role === "admin") router.replace("/admin");
    else router.replace("/workspace");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      await routeByRole(cred.user.uid, email);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      // Bootstrap path: first admin account is created from the login form,
      // only for the configured bootstrap email.
      if (
        BOOTSTRAP_ADMIN_EMAILS.includes(email.trim().toLowerCase()) &&
        (code === "auth/user-not-found" || code === "auth/invalid-credential")
      ) {
        try {
          const existing = await signInWithEmailAndPassword(auth, email.trim(), password);
          await routeByRole(existing.user.uid, email);
          return;
        } catch {
          /* fall through to creation attempt */
        }
        try {
          const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
          await setDoc(doc(db, "users", cred.user.uid), {
            email: email.trim().toLowerCase(),
            role: "admin",
            displayName: "Administrator",
            createdAt: serverTimestamp(),
          });
          setNotice("Admin account created.");
          router.replace("/admin");
          return;
        } catch (createErr: unknown) {
          const cCode = (createErr as { code?: string }).code ?? "";
          if (cCode === "auth/email-already-in-use") {
            setError("Wrong password for this account.");
          } else {
            setError("Could not create the admin account (" + cCode + ").");
          }
          setBusy(false);
          return;
        }
      }
      const friendly: Record<string, string> = {
        "auth/invalid-credential": "Incorrect email or password.",
        "auth/user-not-found": "No account found for this email.",
        "auth/wrong-password": "Incorrect email or password.",
        "auth/too-many-requests": "Too many attempts — try again in a moment.",
        "auth/invalid-email": "That doesn't look like a valid email address.",
      };
      setError(friendly[code] ?? "Sign-in failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(1200px 600px at 70% -10%, #fdeef1 0%, #ffffff 55%)",
        padding: 24,
      }}
    >
      <div className="fade-in" style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 11,
                background: "var(--primary)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 17,
              }}
            >
              iC
            </span>
            <span style={{ fontWeight: 700, fontSize: 19, letterSpacing: "-0.01em" }}>
              ICOMS
            </span>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Welcome back
          </h1>
          <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
            Milk powder quality assessment platform
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card" style={{ padding: 28 }}>
          <div className="field">
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="error-text" style={{ marginBottom: 14 }}>{error}</p>}
          {notice && <p className="success-text" style={{ marginBottom: 14 }}>{notice}</p>}

          <button className="btn" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? <span className="spinner" /> : "Sign in"}
          </button>

          <p
            className="muted small"
            style={{ textAlign: "center", marginTop: 16 }}
          >
            Administrator? <span style={{ color: "var(--primary)", fontWeight: 600 }}>Login as admin</span>{" "}
            with your admin credentials.
          </p>
        </form>

        <p className="muted small" style={{ textAlign: "center", marginTop: 18 }}>
          Access is by invitation only — contact your administrator.
        </p>
      </div>
    </main>
  );
}
