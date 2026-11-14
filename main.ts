// ai-happy-01 — "Tea at Twilight"
//
// The sun and the moon meet for a cup of tea in the dusk sky, and the steam
// between their cups curls into one small heart. A little star keeps watch.
//
// Pure Node standard library: the scene is rendered with signed distance fields
// (supersampled 3x, box-downscaled for clean anti-aliasing), then encoded by
// hand as a 1024x1024 8-bit RGB PNG (zlib + CRC32) and written to
// $MAKEFUN_OUTPUT_DIR/entry.png (default /output/entry.png).
//
// Deterministic: no randomness, no clock, no network. Two runs write identical
// bytes. Run: node main.ts   (dev: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 3; // supersampling factor
const AA = W * SS; // coverage sharpness for a 1-SS-pixel anti-aliased edge

// ---------------------------------------------------------------- colors
function hx(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function mixC(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Dusk sky: warm apricot around the sun (bottom left) to periwinkle behind the moon.
const SKY_STOPS = [
  [0.0, hx('#FFC7A2')],
  [0.42, hx('#F3B7D6')],
  [0.75, hx('#ABA4E1')],
  [1.0, hx('#8690DB')],
];
function skyGradient(u) {
  const s = SKY_STOPS;
  if (u <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (u <= s[i][0]) {
      const t = (u - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      return mixC(s[i - 1][1], s[i][1], t);
    }
  }
  return s[s.length - 1][1];
}

// ---------------------------------------------------------------- scene layout (unit coords, y down)
const SUN = { x: 0.265, y: 0.695, r: 0.175 };
const MOON = { x: 0.77, y: 0.275, r: 0.14 };
const HEART = { x: 0.525, y: 0.335 };
const STAR = { x: 0.85, y: 0.735, r: 0.052 };
const GLOWS = [
  { x: SUN.x, y: SUN.y, R: 0.46, A: 0.45, c: hx('#FFE2A4') },
  { x: MOON.x, y: MOON.y, R: 0.27, A: 0.30, c: hx('#C9D3FF') },
  { x: HEART.x, y: HEART.y, R: 0.15, A: 0.18, c: hx('#FFB3C9') },
];

// ---------------------------------------------------------------- SDF helpers
function sdCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}
function sdEllipse(px, py, cx, cy, rx, ry) {
  const dx = (px - cx) / rx, dy = (py - cy) / ry;
  return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
}
// Arc stroke: circle radius r around (cx,cy), limited to mid +- halfSpan
// (angles in atan2 space, y down), stroke width w.
function sdArc(px, py, cx, cy, r, mid, halfSpan, w) {
  let d = Math.atan2(py - cy, px - cx) - mid;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  const cl = clamp(d, -halfSpan, halfSpan);
  const qx = cx + r * Math.cos(mid + cl);
  const qy = cy + r * Math.sin(mid + cl);
  const dx = px - qx, dy = py - qy;
  return Math.sqrt(dx * dx + dy * dy) - w * 0.5;
}
// Convex polygon as the max of its edge half-planes (winding auto-corrected).
// Returns the raw distance function; subtract a radius for rounded corners.
function makeConvex(pts) {
  const n = pts.length;
  const edges = [];
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.sqrt(ex * ex + ey * ey) || 1;
    let nx = ey / len, ny = -ex / len; // candidate outward normal
    if ((cx - a[0]) * nx + (cy - a[1]) * ny > 0) { nx = -nx; ny = -ny; }
    edges.push([a[0], a[1], nx, ny]);
  }
  return function (px, py) {
    let d = -1e9;
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const dist = (px - e[0]) * e[2] + (py - e[1]) * e[3];
      if (dist > d) d = dist;
    }
    return d;
  };
}
function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
// Rounded 5-point star (ported from iq's sdStar5; y-up convention, feed y flipped).
function sdStar5(px, py, r, rf) {
  const k1x = 0.809016994, k1y = -0.587785252;
  let x = Math.abs(px), y = py;
  const d1 = x * k1x + y * k1y;
  if (d1 > 0) { x -= 2 * d1 * k1x; y -= 2 * d1 * k1y; }
  const d2 = x * -k1x + y * k1y;
  if (d2 > 0) { x -= 2 * d2 * -k1x; y -= 2 * d2 * k1y; }
  x = Math.abs(x);
  y -= r;
  const bax = rf * 0.587785252, bay = rf * 0.809016994 - 1;
  const bb = bax * bax + bay * bay;
  const h = clamp((x * bax + y * bay) / bb, 0, r);
  const dx = x - bax * h, dy = y - bay * h;
  return Math.sqrt(dx * dx + dy * dy) * (y * bax - x * bay < 0 ? -1 : 1);
}
function segDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
  t = clamp(t, 0, 1);
  const dx = px - (ax + ex * t), dy = py - (ay + ey * t);
  return Math.sqrt(dx * dx + dy * dy);
}
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}
function sampleBezier(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(cubic(p0, p1, p2, p3, i / n));
  return pts;
}

// ---------------------------------------------------------------- shape plumbing
// A shape = {x0,y0,x1,y1, f(px,py,out)}; f writes alpha + rgb into out.
const out = { a: 0, r: 0, g: 0, b: 0 };
const shapes = [];
function marginFor(K) { return 1.6 / K + 0.001; }
function addShape(x0, y0, x1, y1, f) {
  shapes.push({ x0, y0, x1, y1, f });
}
function disc(cx, cy, r, color, K = AA, alpha = 1) {
  const m = marginFor(K);
  addShape(cx - r - m, cy - r - m, cx + r + m, cy + r + m, (px, py, o) => {
    const d = sdCircle(px, py, cx, cy, r);
    const a = clamp(0.5 - d * K, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
// Disc whose color runs from center to edge (subtle radial shading).
function shadedDisc(cx, cy, r, cIn, cOut) {
  const m = marginFor(AA);
  addShape(cx - r - m, cy - r - m, cx + r + m, cy + r + m, (px, py, o) => {
    const d = sdCircle(px, py, cx, cy, r);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    const t = clamp((d + r) / r, 0, 1); // d is signed: 0 at center, 1 at the rim
    const c = mixC(cIn, cOut, t * t);
    o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
  });
}
function arcStroke(cx, cy, r, mid, halfSpan, w, color, alpha = 1) {
  const m = r + w * 0.5 + marginFor(AA);
  addShape(cx - m, cy - m, cx + m, cy + m, (px, py, o) => {
    const d = sdArc(px, py, cx, cy, r, mid, halfSpan, w);
    const a = clamp(0.5 - d * AA, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
// Convex polygon dilated by rr (rounded corners), flat color.
function convexShape(pts, rr, color, alpha = 1) {
  const f = makeConvex(pts);
  const m = rr + marginFor(AA);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  addShape(x0 - m, y0 - m, x1 + m, y1 + m, (px, py, o) => {
    const d = f(px, py) - rr;
    const a = clamp(0.5 - d * AA, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
// 4-point sparkle: (|x/e|^0.55 + |y/e|^0.55 = 1), e = tip half-extent.
function sparkle(cx, cy, e, color, alpha = 0.9) {
  const K = 130;
  const m = e * 1.1 + marginFor(K);
  addShape(cx - m, cy - m, cx + m, cy + m, (px, py, o) => {
    const ax = Math.abs(px - cx) / e, ay = Math.abs(py - cy) / e;
    const f = Math.pow(ax, 0.55) + Math.pow(ay, 0.55) - 1;
    const a = clamp(0.5 - f * K, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
// Polyline stroke (steam curls).
function strokeShape(pts, w, color, alpha) {
  const m = w * 0.5 + marginFor(AA);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  addShape(x0 - m, y0 - m, x1 + m, y1 + m, (px, py, o) => {
    let d = 1e9;
    for (let i = 0; i < pts.length - 1; i++) {
      const dd = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (dd < d) d = dd;
    }
    d -= w * 0.5;
    const a = clamp(0.5 - d * AA, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}

// ---------------------------------------------------------------- background
function background(x, y, o) {
  const u = 0.80 * x + 0.20 * (1 - y);
  const c = skyGradient(u);
  let r = c[0], g = c[1], b = c[2];
  for (let i = 0; i < GLOWS.length; i++) {
    const G = GLOWS[i];
    const dx = x - G.x, dy = y - G.y;
    const t = Math.sqrt(dx * dx + dy * dy) / G.R;
    if (t < 1) {
      const a = G.A * (1 - t * t) * (1 - t * t);
      r += (G.c[0] - r) * a; g += (G.c[1] - g) * a; b += (G.c[2] - b) * a;
    }
  }
  o[0] = r; o[1] = g; o[2] = b;
}

// ---------------------------------------------------------------- palette
const C = {
  ray: hx('#FFAC4F'),
  sunIn: hx('#FFDD85'), sunOut: hx('#FFC050'),
  sunFace: hx('#6E3B1E'), sunHi: hx('#FFF6E3'),
  mouth: hx('#7E3B20'), tongue: hx('#F08062'), cheekSun: hx('#FF9B72'),
  moonIn: hx('#F8FAFF'), moonOut: hx('#E4E9F6'),
  crater: hx('#D7DCF2'), moonFace: hx('#6C6DAE'), cheekMoon: hx('#F5A8C0'),
  cloud: hx('#FFF7EB'), cloudShade: hx('#E9DCF3'),
  cup: hx('#FFFEF8'), rim: hx('#E8B98C'), tea: hx('#C07C48'),
  steam: hx('#FFF2F6'),
  heart: hx('#FF7D9C'), heartHi: hx('#FFD3E0'),
  star: hx('#FFE9A8'), starFace: hx('#A87840'),
  cool: hx('#E9EDFF'), warm: hx('#FFDCC4'), pink: hx('#FFC9D9'),
};

// ---------------------------------------------------------------- scene build

// sky sparkles and dots (behind everything)
const sparkCool = [
  [0.115, 0.105, 0.020], [0.205, 0.235, 0.012], [0.070, 0.335, 0.011], [0.145, 0.045, 0.010],
  [0.660, 0.075, 0.011], [0.930, 0.115, 0.015], [0.955, 0.300, 0.010], [0.885, 0.050, 0.008],
  [0.950, 0.520, 0.012], [0.905, 0.870, 0.010], [0.740, 0.925, 0.009], [0.500, 0.245, 0.009],
];
const sparkWarm = [[0.415, 0.135, 0.010]];
const sparkPink = [[0.618, 0.255, 0.008], [0.398, 0.420, 0.007]]; // drawn after the heart
const dotsCool = [
  [0.260, 0.115, 0.006], [0.420, 0.075, 0.005], [0.600, 0.185, 0.005], [0.830, 0.185, 0.006],
  [0.930, 0.400, 0.005], [0.965, 0.630, 0.006], [0.860, 0.800, 0.005], [0.690, 0.880, 0.005],
  [0.055, 0.200, 0.005],
];
const dotsWarm = [[0.330, 0.215, 0.006]];
for (const [x, y, s] of sparkCool) sparkle(x, y, s, C.cool, 0.9);
for (const [x, y, s] of sparkWarm) sparkle(x, y, s, C.warm, 0.85);
for (const [x, y, s] of dotsCool) disc(x, y, s, C.cool, AA, 0.85);
for (const [x, y, s] of dotsWarm) disc(x, y, s, C.warm, AA, 0.85);

// sun rays: 8 rounded triangles attached to the disc
{
  const r0 = 0.183, rt = 0.222, hw = 0.034, rr = 0.012;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const dirx = Math.sin(a), diry = -Math.cos(a); // 0 = up
    const px = -diry, py = dirx;
    const tip = [SUN.x + dirx * rt, SUN.y + diry * rt];
    const b1 = [SUN.x + dirx * r0 + px * hw, SUN.y + diry * r0 + py * hw];
    const b2 = [SUN.x + dirx * r0 - px * hw, SUN.y + diry * r0 - py * hw];
    convexShape([tip, b1, b2], rr, C.ray, 0.95);
  }
}

// sun body and face
shadedDisc(SUN.x, SUN.y, SUN.r, C.sunIn, C.sunOut);
disc(SUN.x - 0.105, SUN.y + 0.005, 0.034, C.cheekSun, 700, 0.85);
disc(SUN.x + 0.105, SUN.y + 0.005, 0.034, C.cheekSun, 700, 0.85);
disc(SUN.x - 0.055, SUN.y - 0.048, 0.024, C.sunFace);
disc(SUN.x + 0.055, SUN.y - 0.048, 0.024, C.sunFace);
disc(SUN.x - 0.063, SUN.y - 0.057, 0.008, C.sunHi);
disc(SUN.x + 0.047, SUN.y - 0.057, 0.008, C.sunHi);
{
  // laughing mouth: half-disc with a flat top, plus a tongue clipped inside it
  const mx = SUN.x, my = 0.752, mr = 0.040, top = 0.744;
  const m = marginFor(AA);
  const mouthTest = (px, py) => Math.max(sdCircle(px, py, mx, my, mr), top - py);
  addShape(mx - mr - m, top - m, mx + mr + m, my + mr + m, (px, py, o) => {
    const d = mouthTest(px, py);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.mouth[0]; o.g = C.mouth[1]; o.b = C.mouth[2];
  });
  const ex = mx, ey = 0.776, erx = 0.016, ery = 0.010;
  addShape(ex - erx - m, ey - ery - m, ex + erx + m, ey + ery + m, (px, py, o) => {
    const d = Math.max(sdEllipse(px, py, ex, ey, erx, ery) - 0.001, mouthTest(px, py));
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.tongue[0]; o.g = C.tongue[1]; o.b = C.tongue[2];
  });
}

// moon body and face
shadedDisc(MOON.x, MOON.y, MOON.r, C.moonIn, C.moonOut);
disc(0.710, 0.198, 0.016, C.crater, 880, 0.75);
disc(0.838, 0.198, 0.014, C.crater, 880, 0.75);
disc(0.800, 0.338, 0.016, C.crater, 880, 0.75);
disc(MOON.x - 0.093, MOON.y + 0.005, 0.028, C.cheekMoon, 700, 0.8);
disc(MOON.x + 0.093, MOON.y + 0.005, 0.028, C.cheekMoon, 700, 0.8);
arcStroke(MOON.x - 0.052, MOON.y - 0.032, 0.026, -Math.PI / 2, Math.PI * 0.42, 0.013, C.moonFace);
arcStroke(MOON.x + 0.052, MOON.y - 0.032, 0.026, -Math.PI / 2, Math.PI * 0.42, 0.013, C.moonFace);
arcStroke(MOON.x, MOON.y + 0.022, 0.024, Math.PI / 2, Math.PI * 0.30, 0.013, C.moonFace);

// little star friend (bottom right)
{
  const m = STAR.r + 0.02;
  addShape(STAR.x - m, STAR.y - m, STAR.x + m, STAR.y + m, (px, py, o) => {
    const d = sdStar5(px - STAR.x, -(py - STAR.y), STAR.r, 0.5) - 0.010;
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.star[0]; o.g = C.star[1]; o.b = C.star[2];
  });
  disc(STAR.x - 0.016, STAR.y - 0.006, 0.0065, C.starFace);
  disc(STAR.x + 0.016, STAR.y - 0.006, 0.0065, C.starFace);
  arcStroke(STAR.x, STAR.y + 0.008, 0.013, Math.PI / 2, Math.PI * 0.28, 0.006, C.starFace);
}

// cloud table (puffy, shaded underneath)
function cloudD(px, py) {
  let d = 1e9;
  const puff = (cx, cy, r) => { d = smin(d, sdCircle(px, py, cx, cy, r), 0.015); };
  puff(0.435, 0.600, 0.048);
  puff(0.475, 0.572, 0.058);
  puff(0.525, 0.560, 0.064);
  puff(0.575, 0.572, 0.058);
  puff(0.615, 0.600, 0.048);
  const base = makeConvex([[0.400, 0.595], [0.650, 0.595], [0.650, 0.632], [0.400, 0.632]]);
  d = smin(d, base(px, py) - 0.018, 0.015);
  return d;
}
{
  const m = 0.035;
  addShape(0.365, 0.475, 0.685, 0.670, (px, py, o) => {
    const d = cloudD(px, py);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.cloud[0]; o.g = C.cloud[1]; o.b = C.cloud[2];
  });
  addShape(0.365, 0.588, 0.685, 0.670, (px, py, o) => {
    const d = Math.max(cloudD(px, py), 0.588 - py);
    const a = clamp(0.5 - d * AA, 0, 1) * 0.55;
    if (a <= 0) return;
    o.a = a; o.r = C.cloudShade[0]; o.g = C.cloudShade[1]; o.b = C.cloudShade[2];
  });
}

// cups: body trapezoid + rim + tea + outward handle, tilted toward each other
function addCup(cx, cy, tilt, mirror) {
  const ca = Math.cos(tilt), sa = Math.sin(tilt);
  function local(px, py) {
    const dx = px - cx, dy = py - cy;
    let lx = dx * ca + dy * sa;
    let ly = -dx * sa + dy * ca;
    if (mirror) lx = -lx;
    return [lx, ly];
  }
  const m = 0.03;
  const bodyF = makeConvex([[-0.023, -0.029], [0.023, -0.029], [0.014, 0.026], [-0.014, 0.026]]);
  const hx0 = mirror ? 0.028 : -0.028;
  const mid = mirror ? 0 : Math.PI;
  // handle first, body drawn over its root
  addShape(cx - 0.055, cy - 0.030, cx + 0.055, cy + 0.030, (px, py, o) => {
    const [lx, ly] = local(px, py);
    const d = sdArc(lx, ly, hx0, -0.006, 0.012, mid, 1.9, 0.0075);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.cup[0]; o.g = C.cup[1]; o.b = C.cup[2];
  });
  addShape(cx - 0.060, cy - 0.045, cx + 0.060, cy + 0.045, (px, py, o) => {
    const [lx, ly] = local(px, py);
    const d = bodyF(lx, ly) - 0.007;
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.cup[0]; o.g = C.cup[1]; o.b = C.cup[2];
  });
  // rim ring
  addShape(cx - 0.060, cy - 0.045, cx + 0.060, cy - 0.010, (px, py, o) => {
    const [lx, ly] = local(px, py);
    const d = Math.abs(sdEllipse(lx, ly, 0, -0.029, 0.026, 0.008)) - 0.0035;
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.rim[0]; o.g = C.rim[1]; o.b = C.rim[2];
  });
  // tea surface
  addShape(cx - 0.060, cy - 0.045, cx + 0.060, cy - 0.010, (px, py, o) => {
    const [lx, ly] = local(px, py);
    const d = sdEllipse(lx, ly, 0, -0.029, 0.019, 0.0045);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.tea[0]; o.g = C.tea[1]; o.b = C.tea[2];
  });
}
addCup(0.462, 0.487, 0.10, false);
addCup(0.588, 0.487, 0.10, true);

// steam curls rising from the cups, tips tucked under the heart
{
  const left = sampleBezier([0.462, 0.449], [0.430, 0.428], [0.548, 0.430], [0.525, 0.398], 22);
  const right = sampleBezier([0.588, 0.449], [0.620, 0.428], [0.502, 0.430], [0.526, 0.398], 22);
  strokeShape(left, 0.0085, C.steam, 0.85);
  strokeShape(right, 0.0085, C.steam, 0.85);
}

// the heart: two lobes + rounded triangle, smoothly united
const heartTri = makeConvex([[-0.063, -0.015], [0.063, -0.015], [0.0, 0.058]]);
function heartD(px, py) {
  const lx = px - HEART.x, ly = py - HEART.y;
  const c1 = sdCircle(lx, ly, -0.029, -0.022, 0.043);
  const c2 = sdCircle(lx, ly, 0.029, -0.022, 0.043);
  return smin(smin(c1, c2, 0.02), heartTri(lx, ly) - 0.015, 0.02);
}
{
  const m = 0.12;
  addShape(HEART.x - m, HEART.y - m, HEART.x + m, HEART.y + m, (px, py, o) => {
    const d = heartD(px, py);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    o.a = a; o.r = C.heart[0]; o.g = C.heart[1]; o.b = C.heart[2];
  });
  // soft highlight on the left lobe, clipped to the heart
  addShape(HEART.x - m, HEART.y - m, HEART.x + m, HEART.y + m, (px, py, o) => {
    const dh = heartD(px, py);
    if (dh > -0.004) return;
    const d = sdEllipse(px, py, HEART.x - 0.030, HEART.y - 0.042, 0.017, 0.010);
    const a = clamp(0.5 - d * 1100, 0, 1) * 0.75;
    if (a <= 0) return;
    o.a = a; o.r = C.heartHi[0]; o.g = C.heartHi[1]; o.b = C.heartHi[2];
  });
}
for (const [x, y, s] of sparkPink) sparkle(x, y, s, C.pink, 0.9);

// ---------------------------------------------------------------- render
const t0 = Date.now();
const bg = new Float64Array(3);
const bgRow = new Float64Array(W * 3);
const acc = new Float64Array(W * 3);
const curBytes = Buffer.alloc(W * 3);
const prevBytes = Buffer.alloc(W * 3);
const raw = Buffer.alloc(H * (1 + W * 3));
const nShapes = shapes.length;

for (let y = 0; y < H; y++) {
  const yc = (y + 0.5) / H;
  for (let x = 0; x < W; x++) {
    background((x + 0.5) / W, yc, bg);
    bgRow[x * 3] = bg[0]; bgRow[x * 3 + 1] = bg[1]; bgRow[x * 3 + 2] = bg[2];
  }
  acc.fill(0);
  for (let sy = 0; sy < SS; sy++) {
    const py = (y + (sy + 0.5) / SS) / H;
    for (let sx = 0; sx < SS; sx++) {
      for (let x = 0; x < W; x++) {
        const px = (x + (sx + 0.5) / SS) / W;
        let r = bgRow[x * 3], g = bgRow[x * 3 + 1], b = bgRow[x * 3 + 2];
        for (let i = 0; i < nShapes; i++) {
          const s = shapes[i];
          if (px < s.x0 || px > s.x1 || py < s.y0 || py > s.y1) continue;
          out.a = 0;
          s.f(px, py, out);
          const a = out.a;
          if (a > 0) {
            const ia = 1 - a;
            r = out.r * a + r * ia;
            g = out.g * a + g * ia;
            b = out.b * a + b * ia;
          }
        }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
      }
    }
  }
  // box downscale to bytes
  for (let i = 0; i < W * 3; i++) {
    curBytes[i] = clamp(Math.round(acc[i] / (SS * SS)), 0, 255);
  }
  // Paeth filter (type 4)
  const rowStart = y * (1 + W * 3);
  raw[rowStart] = 4;
  for (let i = 0; i < W * 3; i++) {
    const a = i >= 3 ? curBytes[i - 3] : 0;
    const b = y > 0 ? prevBytes[i] : 0;
    const c = i >= 3 && y > 0 ? prevBytes[i - 3] : 0;
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    raw[rowStart + 1 + i] = (curBytes[i] - pred) & 255;
  }
  curBytes.copy(prevBytes);
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0);
  o.write(type, 4, 'ascii');
  data.copy(o, 8);
  o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length);
  return o;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: truecolor RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter method
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const outPath = join(outDir, 'entry.png');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath}: ${png.length} bytes, ${W}x${H}, in ${Date.now() - t0} ms`);
