"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

const NAV = [
  { href: "/admin", label: "Overview", icon: "◫" },
  { href: "/admin/models", label: "Models", icon: "◈" },
  { href: "/admin/orgs", label: "Organisations", icon: "▣" },
  { href: "/admin/invitations", label: "Invitations", icon: "✉" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<"loading" | "ok" | "denied">("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace("/login");
        return;
      }
      const snap = await getDoc(doc(db, "users", u.uid));
      if (snap.exists() && snap.data().role === "admin") {
        setUser(u);
        setState("ok");
      } else {
        setState("denied");
      }
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

  if (state === "denied") {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div className="card" style={{ maxWidth: 420, textAlign: "center" }}>
          <h2 style={{ marginBottom: 10 }}>Admin access required</h2>
          <p className="muted" style={{ marginBottom: 18 }}>
            This account does not have administrator permissions.
          </p>
          <button className="btn" onClick={() => signOut(auth).then(() => router.replace("/login"))}>
            Back to login
          </button>
        </div>
      </main>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--surface-2)" }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "22px 14px",
          position: "sticky",
          top: 0,
          height: "100vh",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 10px", marginBottom: 30 }}>
          <span
            style={{
              width: 34, height: 34, borderRadius: 10,
              background: "var(--primary)", color: "#fff",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 15,
            }}
          >
            iC
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>ICOMS</div>
            <div className="muted" style={{ fontSize: 11.5 }}>Admin console</div>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: "flex", alignItems: "center", gap: 11,
                  padding: "10px 12px", borderRadius: 10,
                  fontWeight: active ? 700 : 500, fontSize: 14,
                  background: active ? "var(--primary-soft)" : "transparent",
                  color: active ? "var(--primary)" : "var(--text)",
                }}
              >
                <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto", padding: "0 10px" }}>
          <Link
            href="/workspace"
            style={{
              display: "block", textAlign: "center", marginBottom: 12,
              padding: "9px 12px", borderRadius: 10, fontSize: 13.5, fontWeight: 600,
              color: "var(--primary)", border: "1.5px solid var(--primary)",
            }}
          >
            ↗ Open tester workspace
          </Link>
          <div className="muted small" style={{ marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis" }}>
            {user?.email}
          </div>
          <button
            className="btn-subtle btn btn-sm"
            style={{ width: "100%" }}
            onClick={() => signOut(auth).then(() => router.replace("/login"))}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: "34px 40px", maxWidth: 1120 }} className="fade-in">
        {children}
      </main>
    </div>
  );
}
