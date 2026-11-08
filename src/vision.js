// Camera tracking for two wizards side by side. Hand gestures come from MediaPipe's
// gesture recognizer and bodies from its pose landmarker. The picture is mirrored,
// so everything here is in screen terms: the left player is on the left (side 0).
import { FilesetResolver, GestureRecognizer, PoseLandmarker } from '@mediapipe/tasks-vision';
import { GESTURE_ELEMENTS } from '../shared/rules.js';

// Short enough to feel instant, long enough that passing hands don't cast.
const HOLD_MS = 450;
const MIN_SCORE = 0.55;

// v keeps MediaPipe's visibility score, so the safe zone can tell when a body part is off screen.
const mirror = (points) => points.map((p) => ({ x: 1 - p.x, y: p.y, v: p.visibility ?? 1 }));
const sideOf = (x) => (x < 0.5 ? 0 : 1);

export class Vision {
  constructor({ video, onGesture }) {
    this.video = video;
    this.onGesture = onGesture;
    this.sides = [emptySide(), emptySide()];
    this.frame = 0;
    this.lastVideoTime = -1;
    this.running = false;
    // Against the AI there is one person on camera, so everything they do is Player 1's.
    this.solo = false;
  }

  sideOf(x) {
    return this.solo ? 0 : sideOf(x);
  }

  async start(onStatus = () => {}) {
    onStatus('Starting the camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    onStatus('Loading hand and body tracking…');
    const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    [this.gestures, this.poses] = await Promise.all([
      GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/gesture_recognizer.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 4,
      }),
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 2,
      }),
    ]);
    this.running = true;
    this.loop();
  }

  loop() {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const now = performance.now();
      // Alternate the two models so each runs at half the frame rate.
      this.frame += 1;
      if (this.frame % 2 === 0) this.readHands(this.gestures.recognizeForVideo(this.video, now), now);
      else this.readBodies(this.poses.detectForVideo(this.video, now).landmarks);
    }
    requestAnimationFrame(() => this.loop());
  }

  readBodies(bodies) {
    const found = [null, null];
    for (const body of bodies) {
      const points = mirror(body);
      const chestX = (points[11].x + points[12].x) / 2;
      found[this.sideOf(chestX)] ??= points;
    }
    found.forEach((points, side) => {
      this.sides[side].pose = points;
    });
  }

  readHands(result, now) {
    const hands = [[], []];
    result.landmarks.forEach((landmarks, i) => {
      const points = mirror(landmarks);
      const top = result.gestures[i]?.[0];
      hands[this.sideOf(points[0].x)].push({
        points,
        gesture: top?.categoryName ?? 'None',
        score: top?.score ?? 0,
      });
    });

    hands.forEach((sideHands, side) => {
      const state = this.sides[side];
      state.hands = sideHands;
      const casting = sideHands
        .filter((hand) => GESTURE_ELEMENTS[hand.gesture] && hand.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)[0];

      if (!casting) {
        state.held = null;
        state.armed = true;
        return;
      }
      if (state.held?.gesture !== casting.gesture) {
        state.held = { gesture: casting.gesture, since: now, hand: casting.points[9] };
        return;
      }
      state.held.hand = casting.points[9];
      // A gesture fires once. Lower your hand (or change gesture) to cast again.
      if (state.armed && now - state.held.since >= HOLD_MS) {
        state.armed = false;
        this.onGesture(side, casting.gesture);
      }
    });
  }

  // How far each side is through holding a gesture, from 0 to 1.
  holdProgress(side, now = performance.now()) {
    const held = this.sides[side].held;
    if (!held || !this.sides[side].armed) return 0;
    return Math.min(1, (now - held.since) / HOLD_MS);
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.gestures?.close();
    this.poses?.close();
  }
}

function emptySide() {
  return { pose: null, hands: [], held: null, armed: true };
}
