"use client";

import { useEffect, useRef, useState } from "react";
import {
  addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import type { ModelDoc, OrgDoc } from "@/lib/types";

const emptyForm = { displayName: "", description: "", storageFile: "", downloadUrl: "" };
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

function StepRow({ step }: { step: { name: string; status: string; conclusion: string | null } }) {
  let icon: React.ReactNode;
  let color = "var(--muted)";
  if (step.status === "completed" && step.conclusion === "success") {
    icon = "✓"; color = "var(--good)";
  } else if (step.status === "completed" && step.conclusion === "failure") {
    icon = "✗"; color = "var(--poor)";
  } else if (step.status === "completed" && step.conclusion === "skipped") {
    icon = "–"; color = "var(--muted)";
  } else if (step.status === "in_progress") {
    icon = <span className="spinner spinner-dark" style={{ width: 13, height: 13 }} />;
    color = "var(--text)";
  } else {
    icon = "○"; color = "var(--muted)";
  }
  const running = step.status === "in_progress";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "7px 0", fontSize: 14 }}>
      <span style={{ width: 18, textAlign: "center", color, display: "inline-flex", justifyContent: "center" }}>{icon}</span>
      <span style={{ color: color === "var(--muted)" ? "var(--muted)" : "var(--text)", fontWeight: running ? 600 : 400 }}>
        {step.name}
      </span>
    </div>
  );
}

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
  const [deleteTarget, setDeleteTarget] = useState<ModelDoc | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Convert-from-Drive panel
  const [driveLink, setDriveLink] = useState("");
  const [force, setForce] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  // Live run progress
  interface Step { name: string; status: string; conclusion: string | null }
  const [steps, setSteps] = useState<Step[]>([]);
  const [runInfo, setRunInfo] = useState<{ status: string; conclusion: string | null; html_url: string } | null>(null);
  const [tracking, setTracking] = useState(false);
  const sawRunningRef = useRef(false);

  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;

    async function tick() {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_URL}/conversion-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, uid: user.uid }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data.found) return;

        // Ignore a previously-completed run until the fresh one starts.
        if (data.status !== "completed") sawRunningRef.current = true;
        if (data.status === "completed" && !sawRunningRef.current) return;

        setSteps(data.steps || []);
        setRunInfo({ status: data.status, conclusion: data.conclusion, html_url: data.html_url });
        if (data.status === "completed") {
          setTracking(false);
          if (data.conclusion === "success") load();
        }
      } catch { /* transient poll error — keep going */ }
    }

    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tracking]);

  async function triggerConversion(e: React.FormEvent) {
    e.preventDefault();
    setConvertMsg(null);
    if (!driveLink.trim()) return;
    if (!BACKEND_URL) {
      setConvertMsg({ ok: false, text: "Backend URL is not configured." });
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setConvertMsg({ ok: false, text: "Your session expired — please sign in again." });
      return;
    }
    setConverting(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${BACKEND_URL}/trigger-conversion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          uid: user.uid,
          drive_link: driveLink.trim(),
          force,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
      setConvertMsg({
        ok: true,
        text: data.message || "Conversion started.",
        url: data.actions_url,
      });
      setDriveLink("");
      // begin live progress tracking
      sawRunningRef.current = false;
      setSteps([]);
      setRunInfo(null);
      setTracking(true);
    } catch (err) {
      setConvertMsg({ ok: false, text: (err as Error).message });
    }
    setConverting(false);
  }

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

  async function confirmDelete() {
    const m = deleteTarget;
    if (!m) return;
    setDeleting(true);
    setError("");
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Your session expired — please sign in again.");
      const idToken = await user.getIdToken();
      const res = await fetch(`${BACKEND_URL}/delete-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          uid: user.uid,
          docId: m.id,
          storageFile: m.storageFile ?? "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Delete failed (${res.status})`);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError("Delete failed: " + (e as Error).message);
    }
    setDeleting(false);
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Models</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Convert models from Google Drive, then rename them and choose which
          organisations can use each one.
        </p>
      </div>

      <form onSubmit={triggerConversion} className="card" style={{ marginBottom: 22 }}>
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Convert from Google Drive</h3>
        <p className="muted small" style={{ marginBottom: 16 }}>
          Paste a link to a Drive <strong>folder</strong> (or a single <code>.pth</code> file)
          shared as “Anyone with the link”. Each new checkpoint is converted to fp16 ONNX,
          fidelity-checked, and published automatically. Already-converted files are skipped.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: "1 1 340px" }}
            placeholder="https://drive.google.com/drive/folders/…"
            value={driveLink}
            onChange={(e) => setDriveLink(e.target.value)}
          />
          <label className="small" style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force reconvert all
          </label>
          <button className="btn" disabled={converting || !driveLink.trim()}>
            {converting ? <span className="spinner" /> : "Start conversion"}
          </button>
        </div>
        {convertMsg && (
          <p className={convertMsg.ok ? "success-text" : "error-text"} style={{ marginTop: 14 }}>
            {convertMsg.ok ? "✓ " : "✗ "}{convertMsg.text}{" "}
            {convertMsg.url && (
              <a href={convertMsg.url} target="_blank" rel="noreferrer" style={{ color: "var(--primary)", fontWeight: 600 }}>
                View progress →
              </a>
            )}
          </p>
        )}
      </form>

      {(tracking || steps.length > 0) && (
        <div className="card fade-in" style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15 }}>
              {!runInfo || runInfo.status !== "completed" ? (
                <><span className="spinner spinner-dark" style={{ marginRight: 10, verticalAlign: -2 }} />Conversion in progress…</>
              ) : runInfo.conclusion === "success" ? (
                <span style={{ color: "var(--good)" }}>✓ Conversion complete</span>
              ) : (
                <span style={{ color: "var(--poor)" }}>✗ Conversion failed</span>
              )}
            </h3>
            {runInfo?.html_url && (
              <a href={runInfo.html_url} target="_blank" rel="noreferrer" className="small" style={{ color: "var(--primary)", fontWeight: 600 }}>
                Open in GitHub →
              </a>
            )}
          </div>

          {steps.length === 0 ? (
            <p className="muted small">Waiting for the runner to start…</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {steps.map((s, i) => <StepRow key={i} step={s} />)}
            </div>
          )}
          {runInfo?.conclusion === "success" && (
            <p className="success-text small" style={{ marginTop: 12 }}>
              New models have been added below.
            </p>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-subtle btn-sm" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Close" : "Add manually instead"}
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
                    <button className="btn btn-ghost btn-sm" onClick={() => { setError(""); setDeleteTarget(m); }}>Remove</button>
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

      {deleteTarget && (
        <div
          onClick={() => !deleting && setDeleteTarget(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(55, 6, 39, 0.35)",
            display: "grid", placeItems: "center", padding: 20,
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card fade-in"
            style={{ maxWidth: 440, width: "100%", padding: 26 }}
          >
            <div
              style={{
                width: 44, height: 44, borderRadius: 12, marginBottom: 16,
                background: "var(--poor-soft)", color: "var(--poor)",
                display: "grid", placeItems: "center", fontSize: 22,
              }}
            >
              🗑
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Delete “{deleteTarget.displayName}”?
            </h3>
            <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 4 }}>
              {deleteTarget.storageFile ? (
                <>
                  This permanently removes the model file from storage and its
                  checksum from the manifest, and deletes it from the platform.
                  <strong style={{ color: "var(--text)" }}> This cannot be undone.</strong>
                </>
              ) : (
                <>This removes the model from the platform. This cannot be undone.</>
              )}
            </p>

            {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 22 }}>
              <button
                className="btn btn-subtle"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn"
                onClick={confirmDelete}
                disabled={deleting}
                style={{ background: "var(--poor)", minWidth: 120 }}
              >
                {deleting ? <span className="spinner" /> : "Delete model"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
