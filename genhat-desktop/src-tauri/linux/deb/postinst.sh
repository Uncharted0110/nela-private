#!/bin/sh
set -e

# Mirror NSIS PREINSTALL model directory scaffolding under the packaged resource tree.
# User-writable models (including FileIndexer weights) live under ~/.local/share/com.genhat.dev/models
# after first app launch; this ensures the bundled tree has the expected layout.

if [ "$1" = "configure" ] || [ "$1" = "abort-upgrade" ] || [ "$1" = "abort-remove" ] || [ "$1" = "abort-deconfigure" ]; then
  MODEL_ROOT="/usr/lib/NELA/models"
  mkdir -p "$MODEL_ROOT/LLM"
  mkdir -p "$MODEL_ROOT/LiquidAI-VLM"
  mkdir -p "$MODEL_ROOT/bge-1.5-embed"
  mkdir -p "$MODEL_ROOT/distilBert-query-router/onnx_model"
  mkdir -p "$MODEL_ROOT/tts/kitten-tts/mini"
  mkdir -p "$MODEL_ROOT/grader/ms-marco-MiniLM-L6-v2-onnx-int8"
  mkdir -p "$MODEL_ROOT/asr/parakeet"
  mkdir -p "$MODEL_ROOT/fileindexer"
fi

exit 0
