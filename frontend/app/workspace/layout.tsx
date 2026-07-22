"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "disabled">("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace("/login");
        return;
      }
      // block deactivated accounts
      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        if (snap.exists() && snap.data().active === false) {
          setState("disabled");
          return;
        }
      } catch { /* if the check fails, fall through and allow */ }
      setUser(u);
      setState("ok");
    });
    return unsub;
  }, [router]);

  if (state === "loading") {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <span className="spinner spinner-dark" />
      </main>
    );
  }

  if (state === "disabled") {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div className="card" style={{ maxWidth: 420, textAlign: "center" }}>
          <h2 style={{ marginBottom: 10 }}>Account deactivated</h2>
          <p className="muted" style={{ marginBottom: 18 }}>
            Your access has been paused. Please contact your administrator.
          </p>
          <button className="btn" onClick={() => signOut(auth).then(() => router.replace("/login"))}>
            Back to login
          </button>
        </div>
      </main>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--surface-2)" }}>
      <header
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "14px 28px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 32, height: 32, borderRadius: 9,
              background: "var(--primary)", color: "#fff",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 14,
            }}
          >
            iC
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>ICOMS</div>
            <div className="muted" style={{ fontSize: 11.5 }}>Quality assessment</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="muted small">{user?.email}</span>
          <button
            className="btn btn-subtle btn-sm"
            onClick={() => signOut(auth).then(() => router.replace("/login"))}
          >
            Sign out
          </button>
        </div>
      </header>
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 24px" }} className="fade-in">
        {children}
      </main>
    </div>
  );
}
