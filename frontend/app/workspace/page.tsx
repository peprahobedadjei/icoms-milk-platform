"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

/** Placeholder — the tester workspace (model picker + prediction UI) is the next build phase. */
export default function WorkspacePage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) router.replace("/login");
      else setEmail(u.email);
    });
    return unsub;
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card fade-in" style={{ maxWidth: 460, textAlign: "center" }}>
        <span
          style={{
            width: 44, height: 44, borderRadius: 12, margin: "0 auto 14px",
            background: "var(--primary)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 800, fontSize: 18,
          }}
        >
          iC
        </span>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Workspace coming soon</h1>
        <p className="muted" style={{ marginBottom: 6 }}>
          Signed in as <strong>{email ?? "…"}</strong>
        </p>
        <p className="muted" style={{ marginBottom: 20 }}>
          The prediction workspace (upload an image, get quality assessment with
          explanation) is being built. You&apos;ll receive an email when it goes live.
        </p>
        <button className="btn btn-ghost" onClick={() => signOut(auth).then(() => router.replace("/login"))}>
          Sign out
        </button>
      </div>
    </main>
  );
}
