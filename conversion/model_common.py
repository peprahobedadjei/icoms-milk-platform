"""Shared model definitions for the conversion pipeline.

Mirrors the validated logic in ResearchAssistant/onnx_pytorch/engine.py:
ResNet-50 (fc -> 2 classes) with a baked-in CAM head that outputs (logits, cams).
For ResNet-50's GAP+fc head this CAM equals Grad-CAM on layer4.
"""

import re
import torch
import torch.nn as nn
import torchvision.models as models

CLASS_NAMES = ["good", "poor"]
NUM_CLASSES = 2
IMG_SIZE = 224


class ResNet50WithCAM(nn.Module):
    """ResNet-50 emitting (logits, per-class CAM maps)."""

    def __init__(self, resnet: nn.Module):
        super().__init__()
        self.features = nn.Sequential(
            resnet.conv1, resnet.bn1, resnet.relu, resnet.maxpool,
            resnet.layer1, resnet.layer2, resnet.layer3, resnet.layer4,
        )
        self.avgpool = resnet.avgpool
        self.fc = resnet.fc

    def forward(self, x):
        feats = self.features(x)                          # [N,2048,7,7]
        pooled = torch.flatten(self.avgpool(feats), 1)
        logits = self.fc(pooled)
        cam_w = self.fc.weight.view(NUM_CLASSES, -1, 1, 1)
        cams = nn.functional.conv2d(feats, cam_w)         # [N,2,7,7]
        return logits, cams


def load_resnet(pth_path: str) -> nn.Module:
    """Load a fold checkpoint into a ResNet-50 with a 2-class head."""
    resnet = models.resnet50(weights=None)
    resnet.fc = nn.Linear(resnet.fc.in_features, NUM_CLASSES)
    state = torch.load(pth_path, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    state = {k.replace("module.", ""): v for k, v in state.items()}
    resnet.load_state_dict(state)
    resnet.eval()
    return resnet


def slugify(name: str) -> str:
    """Turn a source filename stem into a safe storage slug."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return slug or "model"
