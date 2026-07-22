"use client";

import { useEffect, useState } from "react";
import emailjs from "@emailjs/browser";
import {
  addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc,
} from "firebase/firestore";
import { createAuthUserAsAdmin, db, generatePassword } from "@/lib/firebase";
import type { InvitationDoc, OrgDoc, Role } from "@/lib/types";

const EMAILJS_SERVICE = process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID ?? "";
const EMAILJS_TEMPLATE = process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID ?? "";
const EMAILJS_KEY = process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY ?? "";
const emailConfigured = Boolean(EMAILJS_SERVICE && EMAILJS_TEMPLATE && EMAILJS_KEY);

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

  async function load() {
    setLoading(true);
    try {
      const [oSnap, iSnap] = await Promise.all([
        getDocs(query(collection(db, "orgs"), orderBy("name"))),
        getDocs(query(collection(db, "invitations"), orderBy("sentAt", "desc"))),
      ]);
      setOrgs(oSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OrgDoc, "id">) })));
      setInvites(iSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<InvitationDoc, "id">) })));
    } catch (e) {
      setError("Could not load data: " + (e as Error).message);
    }
    setLoading(false);
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
        createdAt: serverTimestamp(),
      });

      // 3. record the invitation
      await addDoc(collection(db, "invitations"), {
        email: cleanEmail,
        orgId: role === "user" ? orgId : "",
        role,
        status: "sent",
        sentAt: serverTimestamp(),
      });

      // 4. send credentials by email (EmailJS) or fall back to showing them
      let emailed = false;
      if (emailConfigured) {
        try {
          await emailjs.send(
            EMAILJS_SERVICE,
            EMAILJS_TEMPLATE,
            {
              to_email: cleanEmail,
              to_name: displayName.trim() || cleanEmail,
              login_email: cleanEmail,
              login_password: password,
              login_url: window.location.origin + "/login",
              org_name: orgs.find((o) => o.id === orgId)?.name ?? "",
            },
            { publicKey: EMAILJS_KEY },
          );
          emailed = true;
        } catch {
          emailed = false;
        }
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

      {!emailConfigured && (
        <div className="card" style={{ marginBottom: 20, background: "var(--primary-soft)", border: "1px solid #f5c8d2" }}>
          <strong style={{ fontSize: 14 }}>EmailJS not configured yet.</strong>
          <span className="muted" style={{ fontSize: 14 }}>
            {" "}Accounts are still created — the generated credentials will be shown to you to send manually.
            Add <code>NEXT_PUBLIC_EMAILJS_SERVICE_ID / _TEMPLATE_ID / _PUBLIC_KEY</code> to <code>.env.local</code> to enable automatic emails.
          </span>
        </div>
      )}

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
                <tr><th>Email</th><th>Role</th><th>Organisation</th><th>Status</th></tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}>{i.email}</td>
                    <td><span className="badge badge-neutral">{i.role}</span></td>
                    <td className="muted">{orgs.find((o) => o.id === i.orgId)?.name ?? "—"}</td>
                    <td><span className="badge badge-primary">{i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
