// 头部朝向追踪：摄像头 + MediaPipe 面部模型（全部本地运行），设置页和截图框共用
import { FaceLandmarker, FilesetResolver } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- 模型 ----------
let landmarker = null;
async function load() {
  const files = await FilesetResolver.forVisionTasks('app://looksnap/node_modules/@mediapipe/tasks-vision/wasm');
  const opts = d => ({ baseOptions: { modelAssetPath: 'app://looksnap/assets/face_landmarker.task', delegate: d },
                       runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true });
  try { landmarker = await FaceLandmarker.createFromOptions(files, opts('GPU')); console.log('[ls] model GPU'); }
  catch (e) { landmarker = await FaceLandmarker.createFromOptions(files, opts('CPU')); console.log('[ls] model CPU'); }
  // 第一次推理很慢（约 1~3 秒），先拿空白图预热
  const c = document.createElement('canvas'); c.width = 320; c.height = 240; c.getContext('2d').fillRect(0, 0, 320, 240);
  landmarker.detectForVideo(c, performance.now());
}
export const modelReady = load().catch(e => console.error('model', e));

// ---------- 摄像头 ----------
const BAD = /virtual|phone|link|obs|droidcam|iriun|camo|ndi|continuity|iphone|android|epoccam|手机|虚拟|ivcam|xsplit|snap camera|manycam/i;
const GOOD = /integrated|built-?in|内置|facetime|hd camera|hd webcam|uvc|webcam|camera/i;
export async function listCameras() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (devs.some(d => d.kind === 'videoinput' && !d.label)) {          // 没授权前拿不到名字，先短暂打开一次
    const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop());
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  return devs.filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label || '摄像头', virtual: BAD.test(d.label) }));
}
export function pickCamera(cams, wantedId) {
  if (wantedId && cams.some(c => c.id === wantedId)) return wantedId;
  const real = cams.filter(c => !c.virtual);
  return (real.find(c => GOOD.test(c.label)) || real[0] || cams[0] || {}).id;
}

export const video = document.createElement('video');
video.playsInline = true; video.muted = true;
let stream = null, streamId = null, offTimer = null;
let pending = null;   // 同时有两处要开摄像头时，只开一次
export function camOn(wantedId) {
  clearTimeout(offTimer);
  if (pending) return pending;
  pending = camOpen(wantedId).finally(() => { pending = null; });
  return pending;
}
async function camOpen(wantedId) {
  const id = pickCamera(await listCameras(), wantedId);
  if (stream && streamId === id) return id;
  camOff();
  stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { exact: id } : undefined, width: 640, height: 480 }, audio: false });
  streamId = id; video.srcObject = stream; await video.play();
  console.log('[ls] camera on', stream.getVideoTracks()[0].label);
  return id;
}
export function camOff() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; streamId = null; }
export function camLater(ms = 20000) { clearTimeout(offTimer); offTimer = setTimeout(camOff, ms); }
export const camIsOn = () => !!stream;

// ---------- 头的朝向 + 平滑 ----------
class LP { constructor() { this.y = null } f(x, a) { this.y = this.y == null ? x : a * x + (1 - a) * this.y; return this.y } }
class OneEuro {   // 慢慢动时强力去抖，快速转头时不拖
  constructor(minC, beta, dC = 1) { this.minC = minC; this.beta = beta; this.dC = dC; this.x = new LP(); this.dx = new LP(); this.t = null }
  a(c, dt) { const tau = 1 / (2 * Math.PI * c); return 1 / (1 + tau / dt) }
  f(x, t) {
    if (this.t == null) { this.t = t; this.dx.f(0, 1); return this.x.f(x, 1) }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const ed = this.dx.f((x - this.x.y) / dt, this.a(this.dC, dt));
    return this.x.f(x, this.a(this.minC + this.beta * Math.abs(ed), dt));
  }
}
const fy = new OneEuro(0.5, 0.2), fp = new OneEuro(0.5, 0.2);
export const T = { pose: null, hist: [], faceSeen: 0 };
let lastVT = -1;
export function track(now = performance.now()) {
  if (!landmarker || !stream || video.readyState < 2 || video.currentTime === lastVT) return;
  lastVT = video.currentTime;
  const r = landmarker.detectForVideo(video, now);
  if (!r.faceLandmarks || !r.faceLandmarks.length) return;
  T.faceSeen = now;
  const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
  let raw;
  if (m) { const d = m.data, fx = d[8], fyv = d[9], fz = d[10];
    raw = { yaw: Math.atan2(fx, fz) * 180 / Math.PI, pitch: Math.atan2(fyv, Math.hypot(fx, fz)) * 180 / Math.PI }; }
  else { const l = r.faceLandmarks[0], L = l[234], R = l[454], N = l[1], Tp = l[10], B = l[152];
    raw = { yaw: ((N.x - (L.x + R.x) / 2) / Math.hypot(R.x - L.x, R.y - L.y)) * 90, pitch: ((N.y - (Tp.y + B.y) / 2) / Math.hypot(B.x - Tp.x, B.y - Tp.y)) * 90 }; }
  T.pose = { yaw: fy.f(raw.yaw, now), pitch: fp.f(raw.pitch, now), ryaw: raw.yaw, rpitch: raw.pitch, t: now };
  T.hist.push(T.pose); while (T.hist.length && now - T.hist[0].t > 1000) T.hist.shift();
}
export const faceOk = (now = performance.now()) => now - T.faceSeen < 500;
export function avgPose(ms) {
  const now = performance.now(), a = T.hist.filter(p => now - p.t <= ms); if (!a.length) return null;
  return { yaw: a.reduce((s, p) => s + p.yaw, 0) / a.length, pitch: a.reduce((s, p) => s + p.pitch, 0) / a.length };
}

// ---------- 摇杆：头偏离「出框那一刻的姿势」多少，框就以对应速度挪 ----------
export const KX = 38, KY = 30, RAMP = 6;
// 返回这一帧框要挪的像素，以及给指示器用的偏移
export function joystick(anchor, cfg, dt, pxScale = 1) {
  const p = T.pose, c = cfg.calib || { sx: -1, sy: 1 }, DEAD = cfg.deadzone;
  const dx = (p.yaw - anchor.yaw) * (c.sx || 1), dy = (p.pitch - anchor.pitch) * (c.sy || 1);
  const ex = Math.sign(dx) * Math.max(0, Math.abs(dx) - DEAD), ey = Math.sign(dy) * Math.max(0, Math.abs(dy) - DEAD), e = Math.hypot(ex, ey);
  let mx = 0, my = 0;
  if (e > 0) { const v = cfg.speed * 380 * pxScale * Math.pow(Math.min(1, e / RAMP), 1.5); mx = ex / e * v * dt; my = ey / e * v * dt; }
  return { dx, dy, moving: e > 0, mx, my, zw: DEAD * KX, zh: DEAD * KY };
}

// ---------- 校准用的最小二乘：x = a·yaw + b·pitch + c ----------
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]]; const d = M[i][i] || 1e-9;
    for (let k = 0; k < 3; k++) if (k !== i) { const f = M[k][i] / d; for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
export function fitMap(S) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (const s of S) { const v = [s.yaw, s.pitch, 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j]; bx[i] += v[i] * s.x; by[i] += v[i] * s.y; } }
  const fit = { X: solve3(A, bx), Y: solve3(A, by) };
  fit.sx = Math.sign(fit.X[0]) || 1; fit.sy = Math.sign(fit.Y[1]) || 1;
  return fit;
}
export function mapToScreen(calib, p) {   // 返回 0~1 的屏幕比例
  return { x: calib.X[0] * p.yaw + calib.X[1] * p.pitch + calib.X[2], y: calib.Y[0] * p.yaw + calib.Y[1] * p.pitch + calib.Y[2] };
}
