"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection, doc, getDoc, getDocs, query, where,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { prepareImage } from "@/lib/imagePrep";
import type { ModelDoc } from "@/lib/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

interface Prediction {
  prediction: string;
  confidence: number;
  probs: Record<string, number>;
  preview_png: string;
  gradcam_png: string;
  time_ms: number;
}

export default function Workspace() {
  const [models, setModels] = useState<ModelDoc[]>([]);
  const [modelId, setModelId] = useState("");
  const [loadingModels, setLoadingModels] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Prediction | null>(null);
  const [fileName, setFileName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) return;
      try {
        const meSnap = await getDoc(doc(db, "users", u.uid));
        const me = meSnap.data() as { role?: string; orgId?: string } | undefined;
        let docs;
        if (me?.role === "admin") {
          docs = await getDocs(collection(db, "models"));
        } else if (me?.orgId) {
          docs = await getDocs(
            query(collection(db, "models"), where("orgIds", "array-contains", me.orgId)),
          );
        } else {
          docs = { docs: [] as never[] };
        }
        const list = docs.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ModelDoc, "id">) }))
          .filter((m) => m.downloadUrl);
        setModels(list);
        if (list.length) setModelId(list[0].id);
      } catch (e) {
        setError("Could not load your models: " + (e as Error).message);
      }
      setLoadingModels(false);
    });
    return unsub;
  }, []);

  const currentModel = models.find((m) => m.id === modelId);

  async function onFile(file: File) {
    if (!currentModel?.downloadUrl) {
      setError("Select a model first.");
      return;
    }
    setError("");
    setResult(null);
    setFileName(file.name);
    setBusy(true);
    try {
      setStatus("Preparing image…");
      const prepared = await prepareImage(file);

      setStatus("Analysing… (first request may take a few seconds)");
      const fd = new FormData();
      fd.append("file", prepared.blob, "upload.jpg");
      fd.append("model_url", currentModel.downloadUrl);

      const res = await fetch(`${BACKEND_URL}/predict`, { method: "POST", body: fd });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Server error (${res.status}): ${detail.slice(0, 140)}`);
      }
      setResult(await res.json());
      setStatus("");
    } catch (e) {
      setError((e as Error).message);
      setStatus("");
    }
    setBusy(false);
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
        Powder milk quality assessment
      </h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 24 }}>
        Choose a model, upload a microscopy image, and get a good / poor assessment
        with an explanation heat-map.
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="field" style={{ marginBottom: 16 }}>
          <label className="label">Model</label>
          {loadingModels ? (
            <span className="muted small"><span className="spinner spinner-dark" style={{ marginRight: 8 }} />loading…</span>
          ) : models.length === 0 ? (
            <p className="muted small">
              No models are assigned to your organisation yet. Please contact your administrator.
            </p>
          ) : (
            <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
          )}
          {currentModel?.description && (
            <p className="muted small" style={{ marginTop: 8 }}>{currentModel.description}</p>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".tif,.tiff,.png,.jpg,.jpeg,.bmp"
          hidden
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <div
          onClick={() => !busy && models.length > 0 && inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && models.length > 0 && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
          }}
          style={{
            border: "2px dashed var(--border)",
            borderRadius: 12,
            padding: 30,
            textAlign: "center",
            cursor: busy || models.length === 0 ? "not-allowed" : "pointer",
            color: "var(--muted)",
            opacity: models.length === 0 ? 0.5 : 1,
          }}
        >
          <strong style={{ color: "var(--text)" }}>Drop an image here</strong> or click to browse<br />
          <span className="small">.tif, .png, .jpg — decoded and prepared in your browser</span>
        </div>

        {status && (
          <p className="muted small" style={{ marginTop: 12 }}>
            <span className="spinner spinner-dark" style={{ marginRight: 8 }} />{status}
          </p>
        )}
        {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      </div>

      {result && (
        <div className="card fade-in">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <span className="label">Input</span>
              <img
                src={`data:image/png;base64,${result.preview_png}`}
                alt="input"
                style={{ width: "100%", borderRadius: 10, marginTop: 6 }}
              />
              <div className="muted small" style={{ marginTop: 6 }}>{fileName}</div>
            </div>
            <div style={{ flex: "1 1 260px" }}>
              <span className="label">Grad-CAM</span>
              <img
                src={`data:image/png;base64,${result.gradcam_png}`}
                alt="grad-cam"
                style={{ width: "100%", borderRadius: 10, marginTop: 6 }}
              />
              <div className="muted small" style={{ marginTop: 6 }}>
                {fileName} — Grad-CAM
              </div>
            </div>
            <div style={{ flex: "1 1 220px" }}>
              <span className="label">Assessment</span>
              <div style={{ marginTop: 10 }}>
                <span
                  className="badge"
                  style={{
                    fontSize: 18,
                    padding: "8px 20px",
                    background: result.prediction === "good" ? "var(--good-soft)" : "var(--poor-soft)",
                    color: result.prediction === "good" ? "var(--good)" : "var(--poor)",
                  }}
                >
                  {result.prediction.toUpperCase()}
                </span>
              </div>
              <div style={{ marginTop: 18 }}>
                {["good", "poor"].map((c) => (
                  <div key={c} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span style={{ textTransform: "capitalize" }}>{c}</span>
                      <span className="muted">{((result.probs[c] ?? 0) * 100).toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 6, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${(result.probs[c] ?? 0) * 100}%`,
                          background: c === "good" ? "var(--good)" : "var(--poor)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>
                {currentModel?.displayName} · {result.time_ms} ms
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
