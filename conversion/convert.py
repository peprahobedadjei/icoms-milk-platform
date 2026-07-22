"""Convert .pth fold checkpoints to fp16 ONNX (with CAM head) — idempotent.

For each .pth in --pth-dir:
  - compute SHA-256
  - if that checksum is already in the manifest and --force is not set: SKIP
  - else: export fp32 -> fp16 ONNX, run the fidelity gate; publish only on PASS

Writes/updates --manifest (a JSON list). Exits non-zero if any new model fails
the fidelity gate, so the workflow does not publish a broken model.

Usage:
  python convert.py --pth-dir _work/pth --out-dir _work/onnx --manifest _work/manifest.json [--force]
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import onnx
import torch
from onnxconverter_common import float16

from model_common import IMG_SIZE, ResNet50WithCAM, load_resnet, slugify
from verify import fidelity_check


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_fp16(resnet, wrapped: ResNet50WithCAM, out_path: Path) -> None:
    fp32_tmp = out_path.with_suffix(".fp32.onnx")
    torch.onnx.export(
        wrapped,
        torch.zeros(1, 3, IMG_SIZE, IMG_SIZE),
        str(fp32_tmp),
        input_names=["input"],
        output_names=["logits", "cams"],
        opset_version=17,
        dynamo=False,
    )
    model = onnx.load(str(fp32_tmp))
    model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model_fp16, str(out_path))
    fp32_tmp.unlink(missing_ok=True)


def load_manifest(path: Path) -> list[dict]:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return []
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pth-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    pth_dir = Path(args.pth_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.manifest)

    manifest = load_manifest(manifest_path)
    known_sha = {m["sha256"]: m for m in manifest}
    used_storage = {m["storage_file"] for m in manifest}

    pth_files = sorted(p for p in pth_dir.rglob("*.pth"))
    if not pth_files:
        print(f"No .pth files found under {pth_dir}")
        manifest_path.write_text(json.dumps(manifest, indent=2))
        return

    print(f"Found {len(pth_files)} .pth file(s)")
    converted, skipped, failures = 0, 0, []

    for pth in pth_files:
        digest = sha256_of(pth)
        stem = pth.stem
        if digest in known_sha and not args.force:
            print(f"  SKIP  {pth.name} (unchanged, already converted)")
            skipped += 1
            continue

        # unique storage filename
        slug = slugify(stem)
        storage = f"{slug}_fp16.onnx"
        n = 2
        while storage in used_storage and known_sha.get(digest, {}).get("storage_file") != storage:
            storage = f"{slug}_{n}_fp16.onnx"
            n += 1
        used_storage.add(storage)

        print(f"  CONVERT  {pth.name} -> {storage}")
        resnet = load_resnet(str(pth))
        wrapped = ResNet50WithCAM(resnet).eval()
        out_path = out_dir / storage
        export_fp16(resnet, wrapped, out_path)

        result = fidelity_check(resnet, wrapped, str(out_path))
        print(f"    fidelity: {result['summary']}")
        if not result["passed"]:
            failures.append((pth.name, result["summary"]))
            out_path.unlink(missing_ok=True)
            continue

        entry = {
            "sha256": digest,
            "source_name": pth.name,
            "display_name": stem,
            "storage_file": storage,
            "fidelity": result["summary"],
            "converted_at": datetime.now(timezone.utc).isoformat(),
        }
        manifest = [m for m in manifest if m["sha256"] != digest]
        manifest.append(entry)
        known_sha[digest] = entry
        converted += 1

    manifest.sort(key=lambda m: m["display_name"].lower())
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nConverted {converted}, skipped {skipped}, failed {len(failures)}")
    for name, why in failures:
        print(f"  FAIL {name}: {why}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
