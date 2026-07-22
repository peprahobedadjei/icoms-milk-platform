"""Upsert model documents into Firestore from the conversion manifest.

Each manifest entry -> models/{docId} where docId is the storage_file stem
(stable). On first insert it seeds displayName + empty orgIds; on later runs it
updates the technical fields but PRESERVES the admin's displayName and orgIds
(so renames and assignments are never clobbered).

Auth: reads the service-account JSON from the FIREBASE_SERVICE_ACCOUNT env var
(set as a GitHub Actions secret). Never commit that JSON.

Usage:
  python update_firestore.py --manifest _work/manifest.json --repo owner/name [--release-tag models]
"""

import argparse
import json
import os
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


def download_url(repo: str, tag: str, storage_file: str) -> str:
    return f"https://github.com/{repo}/releases/download/{tag}/{storage_file}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--release-tag", default="models")
    args = ap.parse_args()

    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not sa_json:
        raise SystemExit("FIREBASE_SERVICE_ACCOUNT env var is not set")
    cred = credentials.Certificate(json.loads(sa_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    manifest = json.loads(Path(args.manifest).read_text())
    print(f"Syncing {len(manifest)} model(s) to Firestore")

    for m in manifest:
        doc_id = Path(m["storage_file"]).stem  # e.g. standard_protein_batch_a_fp16
        ref = db.collection("models").document(doc_id)
        snap = ref.get()

        # fields always kept in sync from the pipeline
        data = {
            "storageFile": m["storage_file"],
            "downloadUrl": download_url(args.repo, args.release_tag, m["storage_file"]),
            "sha256": m["sha256"],
            "sourceName": m.get("source_name"),
            "fidelity": m.get("fidelity"),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }

        if snap.exists:
            # preserve admin-managed fields (displayName, description, orgIds)
            ref.set(data, merge=True)
            print(f"  update  {doc_id}")
        else:
            data.update({
                "displayName": m["display_name"],
                "description": "",
                "orgIds": [],
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
            ref.set(data)
            print(f"  create  {doc_id}  ({m['display_name']})")

    print("Firestore sync complete.")


if __name__ == "__main__":
    main()
