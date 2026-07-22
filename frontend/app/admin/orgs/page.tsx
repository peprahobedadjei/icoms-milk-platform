"use client";

import { useEffect, useState } from "react";
import {
  addDoc, collection, deleteDoc, doc, getDocs, orderBy, query, serverTimestamp, updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { OrgDoc } from "@/lib/types";

export default function OrgsPage() {
  const [orgs, setOrgs] = useState<OrgDoc[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "orgs"), orderBy("name")));
      setOrgs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OrgDoc, "id">) })));
    } catch (e) {
      setError("Could not load organisations: " + (e as Error).message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await addDoc(collection(db, "orgs"), {
        name: name.trim(),
        createdAt: serverTimestamp(),
      });
      setName("");
      await load();
    } catch (e) {
      setError("Could not create organisation: " + (e as Error).message);
    }
    setBusy(false);
  }

  async function saveRename(id: string) {
    if (!editName.trim()) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, "orgs", id), { name: editName.trim() });
      setEditingId(null);
      await load();
    } catch (e) {
      setError("Rename failed: " + (e as Error).message);
    }
    setBusy(false);
  }

  async function removeOrg(id: string, orgName: string) {
    if (!confirm(`Delete organisation "${orgName}"? Users in it will lose model access.`)) return;
    setBusy(true);
    try {
      await deleteDoc(doc(db, "orgs", id));
      await load();
    } catch (e) {
      setError("Delete failed: " + (e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Organisations</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 26 }}>
        Each tester belongs to one organisation; models are assigned per organisation.
      </p>

      <form onSubmit={createOrg} className="card" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 22, padding: 18 }}>
        <input
          className="input"
          placeholder="New organisation name — e.g. ATU Dairy Lab"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn" disabled={busy || !name.trim()}>Create</button>
      </form>

      {error && <p className="error-text" style={{ marginBottom: 14 }}>{error}</p>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 30, display: "grid", placeItems: "center" }}>
            <span className="spinner spinner-dark" />
          </div>
        ) : orgs.length === 0 ? (
          <p className="muted" style={{ padding: 26, textAlign: "center" }}>
            No organisations yet — create the first one above.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th style={{ width: 210, textAlign: "right" }}>Actions</th></tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>
                    {editingId === o.id ? (
                      <input
                        className="input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveRename(o.id)}
                        autoFocus
                        style={{ maxWidth: 340 }}
                      />
                    ) : (
                      <span style={{ fontWeight: 600 }}>{o.name}</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {editingId === o.id ? (
                      <span style={{ display: "inline-flex", gap: 8 }}>
                        <button className="btn btn-sm" onClick={() => saveRename(o.id)} disabled={busy}>Save</button>
                        <button className="btn btn-subtle btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", gap: 8 }}>
                        <button
                          className="btn btn-subtle btn-sm"
                          onClick={() => { setEditingId(o.id); setEditName(o.name); }}
                        >
                          Rename
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeOrg(o.id, o.name)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
