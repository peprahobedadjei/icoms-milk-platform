"""Download .pth files from a Google Drive folder or single-file link via gdown.

Usage:
  python download_drive.py "<drive link>" <out_dir>

Accepts a folder link (downloads all files) or a single-file link. The Drive
items must be shared as "Anyone with the link: Viewer".
"""

import sys
from pathlib import Path

import gdown


def main():
    if len(sys.argv) != 3:
        print("usage: python download_drive.py <drive_link> <out_dir>")
        raise SystemExit(2)

    link, out_dir = sys.argv[1], sys.argv[2]
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    if "/folders/" in link or "folderview" in link:
        print(f"Downloading Drive FOLDER -> {out_dir}")
        gdown.download_folder(url=link, output=out_dir, quiet=False, use_cookies=False)
    else:
        print(f"Downloading Drive FILE -> {out_dir}")
        gdown.download(url=link, output=out_dir + "/", quiet=False, fuzzy=True)

    pth = list(Path(out_dir).rglob("*.pth"))
    print(f"Downloaded {len(pth)} .pth file(s):")
    for p in pth:
        print(f"  - {p.relative_to(out_dir)} ({p.stat().st_size/1e6:.1f} MB)")
    if not pth:
        print("WARNING: no .pth files found in the download.")


if __name__ == "__main__":
    main()
