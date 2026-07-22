"use client";

import { useEffect, useState } from "react";
import {
  addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc,
} from "firebase/firestore";
import { auth, createAuthUserAsAdmin, db, generatePassword } from "@/lib/firebase";
import type { InvitationDoc, OrgDoc, Role } from "@/lib/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

interface CreatedCreds { email: string; password: string; emailed: boolean; }

export default function InvitationsPage() {
  const [orgs, setOrgs] = useState<OrgDoc[]>([]);
  const [invites, setInvites] = useState<InvitationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creds, setCreds] = useState<CreatedCreds | null>(null);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [role, setRole] = useState<Role>("user");

  // user records keyed by email (uid + active), for the active/inactive toggle
  const [usersByEmail, setUsersByEmail] = useState<Record<string, { uid: string; active: boolean }>>({});

  async function load() {
    setLoading(true);
    try {
      const [oSnap, iSnap, uSnap] = await Promise.all([
        getDocs(query(collection(db, "orgs"), orderBy("name"))),
        getDocs(query(collection(db, "invitations"), orderBy("sentAt", "desc"))),
        getDocs(collection(db, "users")),
      ]);
      setOrgs(oSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OrgDoc, "id">) })));
      setInvites(iSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<InvitationDoc, "id">) })));
      const map: Record<string, { uid: string; active: boolean }> = {};
      uSnap.docs.forEach((d) => {
        const u = d.data() as { email?: string; active?: boolean };
        if (u.email) map[u.email] = { uid: d.id, active: u.active !== false };
      });
      setUsersByEmail(map);
    } catch (e) {
      setError("Could not load data: " + (e as Error).message);
    }
    setLoading(false);
  }

  function userFor(inv: InvitationDoc) {
    return usersByEmail[inv.email] ?? (inv.uid ? { uid: inv.uid, active: true } : null);
  }

  async function toggleActive(inv: InvitationDoc) {
    const u = userFor(inv);
    if (!u) { setError("No account found for " + inv.email); return; }
    try {
      await updateDoc(doc(db, "users", u.uid), { active: !u.active });
      setUsersByEmail((m) => ({ ...m, [inv.email]: { uid: u.uid, active: !u.active } }));
    } catch (e) {
      setError("Could not update access: " + (e as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setCreds(null);
    if (role === "user" && !orgId) {
      setError("Pick an organisation for the tester.");
      return;
    }
    setBusy(true);
    try {
      const password = generatePassword();
      const cleanEmail = email.trim().toLowerCase();

      // 1. create the Firebase Auth account (secondary app — admin stays signed in)
      const uid = await createAuthUserAsAdmin(cleanEmail, password);

      // 2. profile document with role + org
      await setDoc(doc(db, "users", uid), {
        email: cleanEmail,
        displayName: displayName.trim() || cleanEmail.split("@")[0],
        role,
        orgId: role === "user" ? orgId : null,
        active: true,
        createdAt: serverTimestamp(),
      });

      // 3. record the invitation (store uid for later management)
      await addDoc(collection(db, "invitations"), {
        email: cleanEmail,
        uid,
        orgId: role === "user" ? orgId : "",
        role,
        status: "sent",
        sentAt: serverTimestamp(),
      });

      // 4. send credentials by email via the backend (Gmail SMTP)
      let emailed = false;
      try {
        const adminToken = await auth.currentUser?.getIdToken();
        const res = await fetch(`${BACKEND_URL}/send-invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idToken: adminToken,
            uid: auth.currentUser?.uid,
            to_email: cleanEmail,
            to_name: displayName.trim() || cleanEmail,
            password,
            role,
            org_name: orgs.find((o) => o.id === orgId)?.name ?? "",
            login_url: window.location.origin + "/login",
          }),
        });
        emailed = res.ok;
      } catch {
        emailed = false;
      }

      setCreds({ email: cleanEmail, password, emailed });
      setEmail("");
      setDisplayName("");
      await load();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      setError(
        code === "auth/email-already-in-use"
          ? "An account with this email already exists."
          : "Invitation failed: " + ((err as Error).message ?? code),
      );
    }
    setBusy(false);
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Invitations</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 26 }}>
        Create a tester account — a password is generated and sent to them by email.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 20, alignItems: "start" }}>
        <form onSubmit={invite} className="card">
          <h3 style={{ fontSize: 15, marginBottom: 16 }}>Invite someone</h3>
          <div className="field">
            <label className="label">Email *</label>
            <input className="input" type="email" required value={email}
              placeholder="tester@example.com"
              onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={displayName}
              placeholder="Their display name"
              onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">Role</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">User (tester)</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {role === "user" && (
            <div className="field">
              <label className="label">Organisation *</label>
              <select className="select" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">Select…</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          )}

          {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

          <button className="btn" style={{ width: "100%" }} disabled={busy}>
            {busy ? <span className="spinner" /> : "Create account & send invite"}
          </button>

          {creds && (
            <div className="fade-in" style={{
              marginTop: 16, padding: 14, borderRadius: 10,
              background: creds.emailed ? "var(--good-soft)" : "var(--surface-2)",
              border: "1px solid var(--border)",
            }}>
              {creds.emailed ? (
                <p className="success-text" style={{ fontWeight: 600 }}>
                  ✓ Invite emailed to {creds.email}
                </p>
              ) : (
                <>
                  <p style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
                    Account created — send these credentials to the tester:
                  </p>
                  <p className="small" style={{ fontFamily: "monospace" }}>
                    email: {creds.email}<br />password: {creds.password}
                  </p>
                  <button
                    type="button"
                    className="btn btn-subtle btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => navigator.clipboard.writeText(
                      `Login: ${window.location.origin}/login\nEmail: ${creds.email}\nPassword: ${creds.password}`,
                    )}
                  >
                    Copy credentials
                  </button>
                </>
              )}
            </div>
          )}
        </form>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 30, display: "grid", placeItems: "center" }}>
              <span className="spinner spinner-dark" />
            </div>
          ) : invites.length === 0 ? (
            <p className="muted" style={{ padding: 26, textAlign: "center" }}>No invitations sent yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Email</th><th>Role</th><th>Organisation</th><th style={{ textAlign: "right" }}>Access</th></tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const u = userFor(i);
                  const active = u ? u.active : true;
                  return (
                    <tr key={i.id}>
                      <td style={{ fontWeight: 600 }}>{i.email}</td>
                      <td><span className="badge badge-neutral">{i.role}</span></td>
                      <td className="muted">{orgs.find((o) => o.id === i.orgId)?.name ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          onClick={() => toggleActive(i)}
                          title={active ? "Click to deactivate" : "Click to activate"}
                          className="badge"
                          style={{
                            cursor: "pointer", border: "none", padding: "5px 14px",
                            background: active ? "var(--good-soft)" : "var(--surface-2)",
                            color: active ? "var(--good)" : "var(--muted)",
                          }}
                        >
                          {active ? "● Active" : "○ Inactive"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
