// Copies the MediaPipe runtime into public/ and downloads the two models HexByte
// uses: hand gestures (with hand points) and body pose. Runs after npm install.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const MODELS = {
  'public/models/gesture_recognizer.task':
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
  'public/models/pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
};

mkdirSync('public/models', { recursive: true });
mkdirSync('public/mediapipe', { recursive: true });

const wasm = 'node_modules/@mediapipe/tasks-vision/wasm';
if (existsSync(wasm)) {
  cpSync(wasm, 'public/mediapipe/wasm', {
    recursive: true,
    filter: (source) => !source.includes('module_internal'),
  });
}

for (const [path, url] of Object.entries(MODELS)) {
  if (existsSync(path)) continue;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    console.log(`Downloaded ${path}`);
  } catch (error) {
    console.warn(`Could not download ${path}: ${error.message}`);
    console.warn('Keyboard mode still works. Run npm install again when online.');
  }
}
