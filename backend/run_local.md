# Run the inference backend locally

```powershell
cd "C:\Users\ObedPeprah-RESEARCH\OneDrive - Atlantic TU\Desktop\Repos\ResearchAssistant\web-platform\backend"

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# point it at local ONNX models (from the onnx_pytorch converter) for dev:
$env:LOCAL_MODELS_DIR = "C:\Users\ObedPeprah-RESEARCH\OneDrive - Atlantic TU\Desktop\Repos\ResearchAssistant\onnx_pytorch\converted_models"

uvicorn app:app --host 127.0.0.1 --port 8020 --reload
```

- `GET  http://127.0.0.1:8020/health`
- `POST http://127.0.0.1:8020/predict` — multipart form:
  - `file`: the image
  - `model_url`: a GitHub Release asset URL (production), **or**
  - `model_file`: a bare filename inside `LOCAL_MODELS_DIR` (dev, e.g. `fold1_fp16.onnx`)

In production on Vercel the frontend sends `model_url` (from Firestore); no
`LOCAL_MODELS_DIR` is set, and models are fetched from GitHub Releases into `/tmp`.
