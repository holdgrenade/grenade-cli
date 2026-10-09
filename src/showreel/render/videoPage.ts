/**
 * Pure: the motion page a showreel video is rendered from (Canvas 2, R1B). One self-contained HTML page that draws the
 * timeline at any instant: the renderer loads it in headless Chrome and calls `window.__showreel.seek(ms)` for each
 * frame, so the picture at a time never depends on when it was asked for. The look is the apps': the dark ground, the
 * three fonts (system fallbacks when the page has none), the status colors. No I/O.
 */
import type { VideoAsset, VideoTimeline } from "./videoTimeline.js";

export interface VideoPageInput {
  timeline: VideoTimeline;
  assets: readonly VideoAsset[];
  width: number;
  height: number;
  /** The mark's picture (a file URL), or none for a drawn "G". */
  markUrl?: string | undefined;
}

export function videoPageHtml(input: VideoPageInput): string {
  const data = JSON.stringify({ timeline: input.timeline, assets: input.assets, width: input.width, height: input.height, mark: input.markUrl ?? null });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Showreel</title>
<style>
:root{--ground:#0F1113;--raised:#181B1F;--strong:#2A2E34;--text:#E8E6E1;--text2:#A9AEB5;--faint:#6F757D;--amber:#F0B341;--green:#4CC38A;--blue:#5B9CF6}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${input.width}px;height:${input.height}px;overflow:hidden;background:var(--ground);color:var(--text);font-family:'IBM Plex Sans',system-ui,sans-serif}
#stage{position:relative;width:${input.width}px;height:${input.height}px;overflow:hidden;background:radial-gradient(120% 90% at 20% 0%,#1F1A10 0%,#121417 55%,#0F1113 100%)}
.scene{position:absolute;inset:0;display:none}
.scene.on{display:block}
.grot{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:700;letter-spacing:-.02em}
.caps{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:${Math.round(input.height * 0.02)}px;color:var(--amber)}
.mark{position:absolute;left:50%;top:50%;width:${Math.round(input.height * 0.16)}px;height:${Math.round(input.height * 0.16)}px;margin-left:-${Math.round(input.height * 0.08)}px;margin-top:-${Math.round(input.height * 0.08)}px;border-radius:22%;background:var(--amber);display:grid;place-items:center;font-family:'Space Grotesk',system-ui,sans-serif;font-weight:800;font-size:${Math.round(input.height * 0.1)}px;color:#0F1113;overflow:hidden}
.mark img{width:100%;height:100%;object-fit:cover;display:block}
.word{position:absolute;left:0;right:0;text-align:center;color:var(--text)}
.wall{position:absolute;left:50%;top:50%;display:grid;gap:${Math.round(input.height * 0.012)}px;transform-style:preserve-3d}
.wall img,.wall video{width:100%;height:100%;object-fit:cover;display:block;border-radius:${Math.round(input.height * 0.008)}px;opacity:.75}
.tile{overflow:hidden;background:var(--raised);border:1px solid var(--strong)}
.fade{position:absolute;inset:0;background:linear-gradient(0deg,#0F1113 0%,rgba(15,17,19,.85) 25%,rgba(15,17,19,0) 70%)}
.board{position:absolute;border-radius:${Math.round(input.height * 0.012)}px;overflow:hidden;border:2px solid transparent;box-shadow:0 ${Math.round(input.height * 0.03)}px ${Math.round(input.height * 0.08)}px rgba(0,0,0,.55);background:#fff}
.board img{display:block;width:100%;height:100%;object-fit:cover}
.board.chosen{border-color:var(--amber)}
.clipbox{position:absolute;border-radius:${Math.round(input.height * 0.012)}px;overflow:hidden;box-shadow:0 ${Math.round(input.height * 0.04)}px ${Math.round(input.height * 0.1)}px rgba(0,0,0,.6);background:#000}
.clipbox img,.clipbox video{display:block;width:100%;height:100%;object-fit:cover}
.foot{position:absolute;left:${Math.round(input.width * 0.06)}px;right:${Math.round(input.width * 0.06)}px;bottom:${Math.round(input.height * 0.07)}px}
.foot .k{color:var(--amber)}
.foot .h{font-size:${Math.round(input.height * 0.052)}px;line-height:1.1;margin-top:${Math.round(input.height * 0.01)}px;max-width:${Math.round(input.width * 0.7)}px}
.foot .l{font-size:${Math.round(input.height * 0.026)}px;color:var(--text2);margin-top:${Math.round(input.height * 0.012)}px;max-width:${Math.round(input.width * 0.6)}px}
.chip{position:absolute;right:${Math.round(input.width * 0.06)}px;bottom:${Math.round(input.height * 0.08)}px;padding:${Math.round(input.height * 0.012)}px ${Math.round(input.height * 0.024)}px;border:2px solid var(--green);color:var(--green);border-radius:${Math.round(input.height * 0.014)}px;font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;font-size:${Math.round(input.height * 0.024)}px}
.label{position:absolute;bottom:${Math.round(input.height * 0.1)}px;color:var(--amber);font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:${Math.round(input.height * 0.022)}px}
.montage{position:absolute;inset:${Math.round(input.height * 0.06)}px;display:grid;grid-template-columns:1fr 1fr;gap:${Math.round(input.height * 0.015)}px}
.montage .tile{opacity:1}
.montage img,.montage video{width:100%;height:100%;object-fit:cover;display:block}
</style></head><body><div id="stage"></div>
<script>
const D = ${data};
const stage = document.getElementById("stage");
const W = D.width, H = D.height;
const assets = new Map(D.assets.map(a => [a.id, a]));
const ease = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
const easeIn = x => Math.pow(Math.max(0, Math.min(1, x)), 3);
const lerp = (a, b, x) => a + (b - a) * x;
const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; (parent || stage).appendChild(e); return e; };
const media = (id, parent) => {
  const a = assets.get(id);
  if (!a) return null;
  let m;
  if (a.kind === "video") { m = document.createElement("video"); m.src = a.url; m.muted = true; m.preload = "auto"; m.playsInline = true; }
  else { m = document.createElement("img"); m.src = a.url; }
  m.dataset.id = id; parent.appendChild(m); return m;
};
const videos = [];
const layers = [];

for (const s of D.timeline.scenes) {
  const root = el("div", "scene");
  root.dataset.kind = s.kind;
  const L = { s, root, parts: {} };
  if (s.kind === "open") {
    const mark = el("div", "mark", root); if (D.mark) { const i = document.createElement("img"); i.src = D.mark; mark.appendChild(i); } else mark.textContent = "G";
    const word = el("div", "word grot", root); word.textContent = "grenade"; word.style.fontSize = Math.round(H * 0.07) + "px"; word.style.top = Math.round(H * 0.58) + "px";
    const day = el("div", "word caps", root); day.textContent = "Showreel · " + s.day; day.style.top = Math.round(H * 0.68) + "px";
    L.parts = { mark, word, day };
  } else if (s.kind === "sentence") {
    const k = el("div", "caps", root); k.textContent = "Showreel"; k.style.position = "absolute"; k.style.left = Math.round(W * 0.1) + "px"; k.style.top = Math.round(H * 0.36) + "px";
    const h = el("div", "grot", root); h.textContent = s.text; h.style.position = "absolute"; h.style.left = Math.round(W * 0.1) + "px"; h.style.right = Math.round(W * 0.1) + "px"; h.style.top = Math.round(H * 0.41) + "px"; h.style.fontSize = Math.round(H * 0.062) + "px"; h.style.lineHeight = "1.12";
    L.parts = { k, h };
  } else if (s.kind === "wall" || s.kind === "close") {
    const cols = s.kind === "wall" ? 6 : 8;
    const wall = el("div", "wall", root);
    const tw = Math.round(W / cols * 1.15), th = Math.round(tw * 0.625);
    wall.style.gridTemplateColumns = "repeat(" + cols + ", " + tw + "px)";
    const rows = Math.ceil(Math.max(cols * 2, s.assets.length) / cols);
    const ww = cols * tw + (cols - 1) * Math.round(H * 0.012), wh = rows * th + (rows - 1) * Math.round(H * 0.012);
    wall.style.width = ww + "px"; wall.style.marginLeft = -ww / 2 + "px"; wall.style.marginTop = -wh / 2 + "px";
    const n = Math.max(cols * 2, s.assets.length);
    for (let i = 0; i < n; i++) { const t = el("div", "tile", wall); t.style.height = th + "px"; media(s.assets[i % s.assets.length], t); }
    el("div", "fade", root);
    if (s.kind === "wall") {
      const word = el("div", "word grot", root); word.textContent = s.word; word.style.fontSize = Math.round(H * 0.16) + "px"; word.style.top = Math.round(H * 0.62) + "px"; word.style.textAlign = "left"; word.style.left = Math.round(W * 0.06) + "px";
      L.parts = { wall, word };
    } else {
      const mark = el("div", "mark", root); if (D.mark) { const i = document.createElement("img"); i.src = D.mark; mark.appendChild(i); } else mark.textContent = "G";
      mark.style.top = Math.round(H * 0.42) + "px";
      const day = el("div", "word grot", root); day.textContent = s.day; day.style.fontSize = Math.round(H * 0.06) + "px"; day.style.top = Math.round(H * 0.56) + "px";
      const k = el("div", "word caps", root); k.textContent = "Showreel"; k.style.top = Math.round(H * 0.65) + "px";
      L.parts = { wall, mark, day, k };
    }
  } else if (s.kind === "chapter") {
    const boards = s.boards.map((id, i) => { const b = el("div", "board" + (id === s.chosen ? " chosen" : ""), root); media(id, b); b.style.width = Math.round(W * 0.34) + "px"; b.style.height = Math.round(W * 0.34 * 0.625) + "px"; b.dataset.i = i; return b; });
    let before = null, clip = null;
    if (s.before) { before = el("div", "clipbox", root); media(s.before, before); const lb = el("div", "label", before); lb.textContent = "Before"; lb.style.left = Math.round(H * 0.03) + "px"; lb.style.bottom = Math.round(H * 0.03) + "px"; }
    if (s.clip) { clip = el("div", "clipbox", root); media(s.clip, clip); if (s.before) { const la = el("div", "label", clip); la.textContent = "After"; la.style.left = Math.round(H * 0.03) + "px"; la.style.bottom = Math.round(H * 0.03) + "px"; } }
    const fade = el("div", "fade", root);
    const foot = el("div", "foot", root);
    const k = el("div", "caps", foot); k.textContent = s.title;
    const h = el("div", "grot h", foot); h.textContent = s.line || s.title;
    if (s.line) { k.textContent = s.title; } else { k.textContent = "Showreel"; }
    let chip = null; if (s.done) { chip = el("div", "chip", root); chip.textContent = s.done; }
    L.parts = { boards, before, clip, fade, foot, chip };
  } else if (s.kind === "montage") {
    const m = el("div", "montage", root);
    const tiles = s.assets.map(id => { const t = el("div", "tile", m); media(id, t); return t; });
    L.parts = { m, tiles };
  }
  layers.push(L);
}
for (const v of stage.querySelectorAll("video")) videos.push(v);

async function seekVideo(v, t) {
  const a = assets.get(v.dataset.id);
  const len = (a && a.seconds) || (isFinite(v.duration) ? v.duration : 0);
  const at = len > 0 ? Math.min(len - 0.05, Math.max(0, t)) : 0;
  if (Math.abs(v.currentTime - at) < 0.02) return;
  await new Promise(r => { const done = () => { v.removeEventListener("seeked", done); r(); }; v.addEventListener("seeked", done); v.currentTime = at; setTimeout(done, 800); });
}

async function seek(ms) {
  const pending = [];
  for (const L of layers) {
    const s = L.s;
    const on = ms >= s.from && ms < s.to;
    L.root.classList.toggle("on", on);
    if (!on) continue;
    const t = (ms - s.from) / 1000, len = (s.to - s.from) / 1000, p = t / len;
    const P = L.parts;
    if (s.kind === "open") {
      const a = ease(t / 0.5);
      P.mark.style.transform = "translateY(" + lerp(0, -H * 0.12, ease((t - 0.6) / 0.5)) + "px) scale(" + lerp(1.6, 1, a) + ")";
      P.mark.style.opacity = a;
      const b = ease((t - 0.7) / 0.5);
      P.word.style.opacity = b; P.word.style.transform = "translateY(" + lerp(H * 0.05, 0, b) + "px)";
      const c = ease((t - 1.0) / 0.5);
      P.day.style.opacity = c;
      const out = easeIn((t - (len - 0.3)) / 0.3);
      L.root.style.opacity = 1 - out;
    } else if (s.kind === "sentence") {
      P.k.style.opacity = ease(t / 0.3);
      const b = ease((t - 0.15) / 0.5);
      P.h.style.opacity = b; P.h.style.transform = "translateY(" + lerp(H * 0.03, 0, b) + "px)";
      L.root.style.opacity = 1 - easeIn((t - (len - 0.3)) / 0.3);
    } else if (s.kind === "wall") {
      const z = lerp(-W * 0.35, W * 0.05, p);
      P.wall.style.transform = "perspective(" + Math.round(W * 0.9) + "px) rotateY(" + lerp(-28, -12, p) + "deg) rotateX(" + lerp(6, 2, p) + "deg) translate3d(" + lerp(W * 0.1, -W * 0.25, p) + "px," + lerp(-H * 0.05, H * 0.02, p) + "px," + z + "px)";
      const b = ease((t - 0.4) / 0.5);
      P.word.style.opacity = b; P.word.style.transform = "translateX(" + lerp(-W * 0.03, 0, b) + "px)";
      L.root.style.opacity = Math.min(ease(t / 0.3), 1 - easeIn((t - (len - 0.25)) / 0.25));
    } else if (s.kind === "chapter") {
      const n = P.boards.length;
      P.boards.forEach((b, i) => {
        const a = ease((t - 0.08 * i) / 0.45);
        const spread = n > 1 ? (i - (n - 1) / 2) : 0;
        const x = W * 0.33 + spread * W * 0.12, y = H * 0.1 + Math.abs(spread) * H * 0.02;
        const settle = ease((t - 0.9) / 0.6);
        const dim = b.classList.contains("chosen") ? 1 : lerp(0.85, 0.35, settle);
        b.style.left = x + "px"; b.style.top = y + "px";
        b.style.transform = "translateY(" + lerp(H * 0.25, 0, a) + "px) rotate(" + spread * 5 + "deg) scale(" + lerp(1, P.clip ? 0.82 : 1, settle) + ")";
        b.style.opacity = a * dim;
        if (P.clip) b.style.transform += " translateX(" + lerp(0, -W * 0.18, settle) + "px)";
      });
      const start = n > 0 ? 0.8 : 0.1;
      const a = ease((t - start) / 0.5);
      const cw = Math.round(W * (P.before ? 0.44 : 0.74)), ch = Math.round(cw * 0.625);
      const place = (box, left) => { box.style.width = cw + "px"; box.style.height = ch + "px"; box.style.left = left + "px"; box.style.top = Math.round(H * 0.08) + "px"; box.style.opacity = a; box.style.transform = "scale(" + lerp(1.12, 1, a) + ") translateY(" + lerp(H * 0.06, 0, a) + "px)"; };
      if (P.before && P.clip) { place(P.before, Math.round(W * 0.05)); place(P.clip, Math.round(W * 0.51)); }
      else if (P.clip) place(P.clip, Math.round(W * 0.13));
      for (const box of [P.before, P.clip]) if (box) for (const v of box.querySelectorAll("video")) pending.push(seekVideo(v, Math.max(0, t - start)));
      const f = ease((t - start - 0.3) / 0.4);
      P.foot.style.opacity = f; P.foot.style.transform = "translateY(" + lerp(H * 0.03, 0, f) + "px)";
      if (P.chip) { const c = ease((t - (len - 0.9)) / 0.25); P.chip.style.opacity = c; P.chip.style.transform = "scale(" + lerp(1.6, 1, c) + ")"; }
      L.root.style.opacity = Math.min(ease(t / 0.25), 1 - easeIn((t - (len - 0.25)) / 0.25));
    } else if (s.kind === "montage") {
      const step = len / Math.max(1, P.tiles.length);
      P.tiles.forEach((tile, i) => { const a = ease((t - i * step) / 0.2); tile.style.opacity = a; tile.style.transform = "scale(" + lerp(0.9, 1, a) + ")"; });
      L.root.style.opacity = 1 - easeIn((t - (len - 0.25)) / 0.25);
    } else if (s.kind === "close") {
      P.wall.style.transform = "perspective(" + Math.round(W * 0.9) + "px) rotateX(" + lerp(10, 6, p) + "deg) translate3d(0," + lerp(H * 0.02, -H * 0.02, p) + "px," + lerp(-W * 0.3, -W * 0.34, p) + "px)";
      P.wall.style.opacity = 0.35;
      const a = ease(t / 0.5); P.mark.style.opacity = a; P.mark.style.transform = "scale(" + lerp(1.3, 1, a) + ")";
      const b = ease((t - 0.3) / 0.5); P.day.style.opacity = b; P.k.style.opacity = ease((t - 0.5) / 0.5);
      L.root.style.opacity = Math.min(ease(t / 0.3), 1 - easeIn((t - (len - 0.4)) / 0.4));
    }
  }
  await Promise.all(pending);
  return ms;
}

async function ready() {
  await Promise.all(Array.from(stage.querySelectorAll("img")).map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; })));
  await Promise.all(videos.map(v => v.readyState >= 1 ? null : new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); })));
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  return true;
}
window.__showreel = { seek, ready, duration: D.timeline.duration };
</script></body></html>`;
}
