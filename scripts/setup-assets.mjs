// Copies the MediaPipe runtime into public/ and downloads the models HexByte uses:
// hand gestures (with hand points), body pose, and faces (not used right now).
// Runs after npm install.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const MODELS = {
  'public/models/gesture_recognizer.task':
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
  'public/models/pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'public/models/face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
};

mkdirSync('public/models', { recursive: true });
mkdirSync('public/mediapipe', { recursive: true });

// Face login: face-api's detector, face points and face recognition models.
const faceModels = 'node_modules/@vladmandic/face-api/model';
if (existsSync(faceModels)) {
  mkdirSync('public/models/face-api', { recursive: true });
  for (const name of ['tiny_face_detector_model', 'face_landmark_68_tiny_model', 'face_recognition_model']) {
    for (const file of [`${name}.bin`, `${name}-weights_manifest.json`]) cpSync(`${faceModels}/${file}`, `public/models/face-api/${file}`);
  }
}

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
