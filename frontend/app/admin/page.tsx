"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, getCountFromServer } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface Counts {
  models: number | null;
  orgs: number | null;
  users: number | null;
  invitations: number | null;
}

const CARDS: { key: keyof Counts; label: string; href: string; hint: string }[] = [
  { key: "models", label: "Models", href: "/admin/models", hint: "ONNX models available to assign" },
  { key: "orgs", label: "Organisations", href: "/admin/orgs", hint: "Groups of invited testers" },
  { key: "users", label: "Users", href: "/admin/invitations", hint: "Accounts on the platform" },
  { key: "invitations", label: "Invitations", href: "/admin/invitations", hint: "Invites sent so far" },
];

export default function AdminOverview() {
  const [counts, setCounts] = useState<Counts>({
    models: null, orgs: null, users: null, invitations: null,
  });

  useEffect(() => {
    (async () => {
      const get = async (name: string) => {
        try {
          const snap = await getCountFromServer(collection(db, name));
          return snap.data().count;
        } catch {
          return 0;
        }
      };
      const [models, orgs, users, invitations] = await Promise.all([
        get("models"), get("orgs"), get("users"), get("invitations"),
      ]);
      setCounts({ models, orgs, users, invitations });
    })();
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Overview</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 28 }}>
        Manage models, organisations and tester access.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 18,
        }}
      >
        {CARDS.map((c) => (
          <Link key={c.label} href={c.href}>
            <div className="card" style={{ padding: 22, cursor: "pointer" }}>
              <div className="muted" style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                {c.label}
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.03em" }}>
                {counts[c.key] ?? "—"}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>{c.hint}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="card" style={{ marginTop: 26 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Getting started</h3>
        <ol className="muted" style={{ paddingLeft: 20, lineHeight: 2 }}>
          <li>Create an <Link href="/admin/orgs" style={{ color: "var(--primary)", fontWeight: 600 }}>organisation</Link> for each group of testers.</li>
          <li>Add or convert <Link href="/admin/models" style={{ color: "var(--primary)", fontWeight: 600 }}>models</Link>, give them clear names, and assign them to organisations.</li>
          <li><Link href="/admin/invitations" style={{ color: "var(--primary)", fontWeight: 600 }}>Invite testers</Link> — credentials are generated and emailed automatically.</li>
        </ol>
      </div>
    </div>
  );
}
