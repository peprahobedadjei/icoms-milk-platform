"use client";

import { useEffect, useState } from "react";
import {
  addDoc, collection, deleteDoc, doc, getDocs, orderBy, query, serverTimestamp, updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { ModelDoc, OrgDoc } from "@/lib/types";

const emptyForm = { displayName: "", description: "", storageFile: "", downloadUrl: "" };

export default function ModelsPage() {
  const [models, setModels] = useState<ModelDoc[]>([]);
  const [orgs, setOrgs] = useState<OrgDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ displayName: "", description: "" });

  async function load() {
    setLoading(true);
    try {
      const [mSnap, oSnap] = await Promise.all([
        getDocs(query(collection(db, "models"), orderBy("displayName"))),
        getDocs(query(collection(db, "orgs"), orderBy("name"))),
      ]);
      setModels(mSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ModelDoc, "id">) })));
      setOrgs(oSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OrgDoc, "id">) })));
    } catch (e) {
      setError("Could not load models: " + (e as Error).message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function addModel(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await addDoc(collection(db, "models"), {
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        storageFile: form.storageFile.trim(),
        downloadUrl: form.downloadUrl.trim(),
        orgIds: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setForm(emptyForm);
      setShowAdd(false);
      await load();
    } catch (e) {
      setError("Could not add model: " + (e as Error).message);
    }
    setBusy(false);
  }

  async function saveEdit(id: string) {
    setBusy(true);
    try {
      await updateDoc(doc(db, "models", id), {
        displayName: edit.displayName.trim(),
        description: edit.description.trim(),
        updatedAt: serverTimestamp(),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError("Save failed: " + (e as Error).message);
    }
    setBusy(false);
  }

  async function toggleOrg(model: ModelDoc, orgId: string) {
    const next = model.orgIds.includes(orgId)
      ? model.orgIds.filter((x) => x !== orgId)
      : [...model.orgIds, orgId];
    try {
      await updateDoc(doc(db, "models", model.id), { orgIds: next, updatedAt: serverTimestamp() });
      setModels((ms) => ms.map((m) => (m.id === model.id ? { ...m, orgIds: next } : m)));
    } catch (e) {
      setError("Assignment failed: " + (e as Error).message);
    }
  }

  async function removeModel(m: ModelDoc) {
    if (!confirm(`Remove model "${m.displayName}" from the platform? (The ONNX file itself is not deleted.)`)) return;
    setBusy(true);
    try {
      await deleteDoc(doc(db, "models", m.id));
      await load();
    } catch (e) {
      setError("Delete failed: " + (e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 26 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Models</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            Rename models, describe them, and choose which organisations can use each one.
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Close" : "+ Add model"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={addModel} className="card fade-in" style={{ marginBottom: 22 }}>
          <h3 style={{ fontSize: 15, marginBottom: 16 }}>Register a converted ONNX model</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Display name *</label>
              <input className="input" required value={form.displayName}
                placeholder="e.g. Standard Protein — Batch A"
                onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Storage file name</label>
              <input className="input" value={form.storageFile}
                placeholder="e.g. fold1_fp16.onnx"
                onChange={(e) => setForm({ ...form, storageFile: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0, gridColumn: "1 / -1" }}>
              <label className="label">Download URL (GitHub Release asset)</label>
              <input className="input" value={form.downloadUrl}
                placeholder="https://github.com/…/releases/download/models-v1/fold1_fp16.onnx"
                onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0, gridColumn: "1 / -1" }}>
              <label className="label">Description</label>
              <textarea className="textarea" rows={2} value={form.description}
                placeholder="Training batch, accuracy, notes for testers…"
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
            <button className="btn" disabled={busy || !form.displayName.trim()}>Save model</button>
            <span className="muted small" style={{ alignSelf: "center" }}>
              The conversion pipeline will also register models here automatically.
            </span>
          </div>
        </form>
      )}

      {error && <p className="error-text" style={{ marginBottom: 14 }}>{error}</p>}

      {loading ? (
        <div className="card" style={{ padding: 30, display: "grid", placeItems: "center" }}>
          <span className="spinner spinner-dark" />
        </div>
      ) : models.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ textAlign: "center", padding: 10 }}>
            No models yet. Add one manually above, or run the conversion pipeline.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {models.map((m) => (
            <div key={m.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === m.id ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520 }}>
                      <input className="input" value={edit.displayName}
                        onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} />
                      <textarea className="textarea" rows={2} value={edit.description}
                        placeholder="Description"
                        onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn btn-sm" onClick={() => saveEdit(m.id)} disabled={busy}>Save</button>
                        <button className="btn btn-subtle btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <h3 style={{ fontSize: 16.5, fontWeight: 700 }}>{m.displayName}</h3>
                        {m.fidelity && <span className="badge badge-good">fidelity {m.fidelity}</span>}
                        {m.metrics?.accuracy != null && (
                          <span className="badge badge-neutral">acc {m.metrics.accuracy}%</span>
                        )}
                      </div>
                      {m.description && (
                        <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>{m.description}</p>
                      )}
                      <p className="muted small" style={{ marginTop: 8, wordBreak: "break-all" }}>
                        {m.storageFile || "no file"}{m.downloadUrl ? ` · ${m.downloadUrl}` : ""}
                      </p>
                    </>
                  )}
                </div>
                {editingId !== m.id && (
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button className="btn btn-subtle btn-sm"
                      onClick={() => { setEditingId(m.id); setEdit({ displayName: m.displayName, description: m.description ?? "" }); }}>
                      Edit
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeModel(m)}>Remove</button>
                  </div>
                )}
              </div>

              <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
                <span className="label" style={{ marginBottom: 10 }}>Assigned organisations</span>
                {orgs.length === 0 ? (
                  <span className="muted small">Create an organisation first.</span>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {orgs.map((o) => {
                      const on = m.orgIds.includes(o.id);
                      return (
                        <button
                          key={o.id}
                          onClick={() => toggleOrg(m, o.id)}
                          className="badge"
                          style={{
                            cursor: "pointer",
                            border: on ? "1.5px solid var(--primary)" : "1.5px solid var(--border)",
                            background: on ? "var(--primary-soft)" : "var(--surface)",
                            color: on ? "var(--primary)" : "var(--muted)",
                            padding: "6px 14px",
                          }}
                        >
                          {on ? "✓ " : ""}{o.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
