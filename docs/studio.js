/* Clip view: Watch, 3D, Points, Files. Uses window.DP (getFile, saveVideo) from index.html. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const COLORS = ["#ff5d5d", "#ffb020", "#3ddc84", "#40c4ff", "#b388ff", "#ff80ab", "#f4ff81", "#ffffff"];
  const DEFAULTS = {
    style: "mesh", strength: 0.6, density: 480, pointSize: 3, invert: false, edge: 35,
    color: "video", bright: 1, bg: "dark",
    dPalette: "turbo", dFarCol: "#1b1f5e", dMidCol: "#e0457b", dNearCol: "#ffd34d",
    dMix: 100, dLo: 0, dHi: 100, dGamma: 1, dSteps: 0, dFlip: false, dHide: false,
    lines: 0, lineW: 15, lineCol: "#ffffff",
    hl: false, hlPos: 50, hlWidth: 4, hlCol: "#ff3b30",
    cutMode: "off", cut: 50, cutType: "depth", planeOff: 0, pPreview: false, pHidden: "checker",
    edgeBlur: 2, edgeSoft: 1,
    proj: "perspective", spin: false,
    speed: 1, loop: true,
  };
  let opt = { ...DEFAULTS, ...store.get("depthpass-view", {}) };
  if (["depth", "heat", "bands"].includes(opt.color)) {      // settings saved by the earlier version
    opt.dPalette = opt.color === "heat" ? "heat" : "grey"; if (opt.color === "bands") opt.lines = 20; opt.color = "distance";
  }
  const saveOpt = () => store.set("depthpass-view", opt);

  // ---------- distance colours ----------
  const PALETTES = {
    grey: ["#000000", "#ffffff"],
    heat: ["#0b0bff", "#00e5ff", "#39ff14", "#ffe600", "#ff2a00"],
    turbo: ["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c7ef34", "#faba39", "#f66b19", "#ca2a04", "#7a0403"],
    viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    magma: ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
    ocean: ["#03071e", "#023e8a", "#0096c7", "#48cae4", "#caf0f8"],
  };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const limits = () => [Math.min(opt.dLo, opt.dHi) / 100, Math.max(opt.dLo, opt.dHi) / 100];
  /** 256 colours, one per depth value from far (0) to near (255), with every colour setting applied. */
  function buildLUT() {
    const stops = (opt.dPalette === "custom" ? [opt.dFarCol, opt.dMidCol, opt.dNearCol] : PALETTES[opt.dPalette] || PALETTES.grey).map(rgb);
    const [lo, hi] = limits(), out = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      let u = Math.min(1, Math.max(0, (i / 255 - lo) / Math.max(hi - lo, 0.001)));
      u = Math.pow(u, opt.dGamma);
      if (opt.dSteps >= 2) u = Math.min(Math.floor(u * opt.dSteps), opt.dSteps - 1) / (opt.dSteps - 1);
      if (opt.dFlip) u = 1 - u;
      const x = u * (stops.length - 1), k = Math.min(Math.floor(x), stops.length - 2), f = x - k;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  const lutKey = () => [opt.dPalette, opt.dFarCol, opt.dMidCol, opt.dNearCol, opt.dLo, opt.dHi, opt.dGamma, opt.dSteps, opt.dFlip].join("|");
  /** Upload the colour table to a GL context (unit 2) when the colour settings changed; also redraw the legends. */
  function uploadLUT(g, tex, holder) {
    const sig = lutKey();
    if (holder.sig === sig) return;
    holder.sig = sig;
    const lut = buildLUT();
    g.activeTexture(g.TEXTURE2); g.bindTexture(g.TEXTURE_2D, tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 256, 1, 0, g.RGBA, g.UNSIGNED_BYTE, lut);
    for (const id of ["st-lut", "st-wlut"]) {
      const c = $(id), ctx = c.getContext("2d"), im = ctx.createImageData(256, 1);
      im.data.set(lut); ctx.putImageData(im, 0, 0);
    }
  }
  const lut3 = { sig: "" };
  const syncLUT = () => uploadLUT(gl, texL, lut3);

  // ---------- state ----------
  let clip = null, tab = "watch", raf = 0, open = false;
  let points = [], selected = -1;
  const cam = { yaw: 0.5, pitch: 0.25, dist: 1.45, panX: 0, panY: 0 };
  const vD = $("st-vd"), vS = $("st-vs");
  let master = vS, aspect = 16 / 9, hasSrc = false;

  // ---------- GL ----------
  const glc = $("st-gl");
  let gl = null, prog = null, U = {}, texD = null, texC = null, texL = null, deriv = false, uint32 = false;
  let grid = { n: 0, verts: 0, tri: 0, line: 0, vb: null, tb: null, lb: null };
  let M = new Float32Array(16);

  const VS = `
attribute vec2 a; uniform sampler2D D; uniform mat4 M; uniform float S, inv, ps; uniform vec2 asp;
varying vec2 v; varying float vd; varying vec3 vp;
void main(){ float d = texture2D(D, a).r; if (inv > 0.5) d = 1.0 - d; vd = d; v = a;
  vp = vec3((a.x - 0.5) * asp.x, (0.5 - a.y) * asp.y, (d - 0.5) * S);
  gl_Position = M * vec4(vp, 1.0); gl_PointSize = ps; }`;
  // Edges fade over about one screen pixel (fwidth) instead of a hard keep/throw-away per pixel; with
  // alpha-to-coverage on, the GPU turns that fade into smooth multisampled edges without sorting.
  const AA = (d) => d ? "#extension GL_OES_standard_derivatives : enable\n#define FW(x) max(fwidth(x), 1e-5)\n" : "#define FW(x) 1e-5\n";
  // Depth as seen by the cut tests: blurred over a small disk (edgeBlur, in depth-map pixels) so outlines
  // follow smooth curves instead of the depth map's steps, plus the depth range inside the disk, which
  // marks a jump between near and far (a silhouette). keep() fades over (0.75 + soft) screen pixels.
  const EDGE_GLSL = `
uniform sampler2D D; uniform vec2 texel; uniform float blurR, invF, soft;
float dAt(vec2 uv) { float d = texture2D(D, uv).r; return invF > 0.5 ? 1.0 - d : d; }
vec2 blurDepth(vec2 uv) {
  float c = dAt(uv);
  if (blurR < 0.25) return vec2(c, 0.0);
  float s = c, w = 1.0, mn = c, mx = c;
  for (int i = 0; i < 12; i++) {
    float outer = i < 6 ? 0.0 : 1.0;
    float ang = float(i) * 1.0472 + outer * 0.5236;
    vec2 o = vec2(cos(ang), sin(ang)) * blurR * (0.5 + 0.5 * outer) * texel;
    float d = dAt(uv + o), k = 1.0 - 0.4 * outer;
    s += d * k; w += k; mn = min(mn, d); mx = max(mx, d);
  }
  return vec2(s / w, mx - mn);
}
float keep(float x) { float w = FW(x) * (0.75 + soft); return smoothstep(-w, w, x); }`;
  const FS = (d) => `${AA(d)}precision mediump float;${EDGE_GLSL}
uniform float SF;
uniform sampler2D C, L; uniform int mode, cutMode, hideOut, planeMode;
uniform float cut, edge, bright, dmix, lo, hi, lines, lineW, hlOn, hlPos, hlW; uniform vec3 lineCol, hlCol; uniform vec4 plane;
varying vec2 v; varying float vd; varying vec3 vp;
void main(){
  float a = 1.0;
  vec2 bd = blurDepth(v);
  float cd = blurR < 0.25 ? vd : bd.x;                 // depth used by the cuts
  float pd = dot(plane.xyz, vec3(vp.xy, (cd - 0.5) * SF)) + plane.w;   // > 0: in front of the 3-point plane
  if (planeMode == 1) a *= keep(pd);
  if (planeMode == 2) a *= keep(-pd);
  if (cutMode == 1) a *= keep(cd - cut);
  if (cutMode == 2) a *= keep(cut - cd);
  ${d ? "if (edge > 0.0) a *= 1.0 - smoothstep(edge * 0.75, edge * 1.35, fwidth(vd));   // stretched mesh: never feathered" : ""}
  vec3 c = texture2D(C, v).rgb;
  if (mode == 1) {
    if (hideOut == 1) a *= keep(cd - lo) * keep(hi - cd);
    c = mix(c, texture2D(L, vec2(vd, 0.5)).rgb, dmix);
    float u = (vd - lo) / max(hi - lo, 0.001);
    if (lines > 0.0 && u > 0.0 && u < 1.0) {
      float t = u * lines, dl = abs(t - floor(t + 0.5)), fw = FW(t);
      c = mix(c, lineCol, 1.0 - smoothstep(lineW * 0.5 - fw, lineW * 0.5 + fw, dl));
    }
    if (hlOn > 0.5) { float fw = FW(vd); c = mix(c, hlCol, 0.85 * (1.0 - smoothstep(hlW - fw, hlW + fw, abs(vd - hlPos)))); }
  }
  c *= bright;
  if (cutMode == 3) { float fw = FW(cd); c = mix(c, vec3(0.2, 0.55, 1.0), 0.85 * (1.0 - smoothstep(0.012 - fw, 0.012 + fw, abs(cd - cut)))); }
  if (planeMode == 3) { float fw = FW(pd); c = mix(c, vec3(0.2, 0.55, 1.0), 0.85 * (1.0 - smoothstep(0.006 - fw, 0.006 + fw, abs(pd)))); }
  if (a < 0.02) discard;
  gl_FragColor = vec4(c, a); }`;

  function initGL() {
    if (gl) return true;
    gl = glc.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) return false;
    deriv = !!gl.getExtension("OES_standard_derivatives");
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS(deriv)));
    gl.bindAttribLocation(prog, 0, "a"); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ["D", "C", "L", "M", "S", "inv", "ps", "asp", "mode", "cutMode", "cut", "edge", "bright", "hideOut", "dmix", "lo", "hi", "lines", "lineW", "hlOn", "hlPos", "hlW", "lineCol", "hlCol", "plane", "planeMode", "texel", "blurR", "invF", "soft", "SF"]) U[n] = gl.getUniformLocation(prog, n);
    const tex = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255])); return t; };
    texD = tex(0); texC = tex(1); texL = tex(2); lut3.sig = "";
    gl.uniform1i(U.D, 0); gl.uniform1i(U.C, 1); gl.uniform1i(U.L, 2);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    uint32 = !!gl.getExtension("OES_element_index_uint");
    return true;
  }

  function buildGrid() {
    const n = uint32 ? opt.density : Math.min(opt.density, 320);
    if (grid.n === n + ":" + aspect.toFixed(3)) return;
    const nx = aspect >= 1 ? n : Math.max(8, Math.round(n * aspect));
    const ny = aspect >= 1 ? Math.max(8, Math.round(n / aspect)) : n;
    const w = nx + 1, h = ny + 1;
    const v = new Float32Array(w * h * 2);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++) { v[i++] = x / nx; v[i++] = y / ny; }
    const big = w * h > 65535, IA = big ? Uint32Array : Uint16Array;
    const t = new IA(nx * ny * 6), l = new IA((nx * h + ny * w) * 2);
    let ti = 0, li = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      t[ti++] = a; t[ti++] = c; t[ti++] = b; t[ti++] = b; t[ti++] = c; t[ti++] = d;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < nx; x++) { l[li++] = y * w + x; l[li++] = y * w + x + 1; }
    for (let y = 0; y < ny; y++) for (let x = 0; x < w; x++) { l[li++] = y * w + x; l[li++] = (y + 1) * w + x; }
    for (const k of ["vb", "tb", "lb"]) if (grid[k]) gl.deleteBuffer(grid[k]);
    grid = { n: n + ":" + aspect.toFixed(3), type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, verts: w * h, tri: t.length, line: l.length,
      vb: gl.createBuffer(), tb: gl.createBuffer(), lb: gl.createBuffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, grid.vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.tb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, t, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.lb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, l, gl.STATIC_DRAW);
  }

  // column-major 4x4 helpers
  function mul(a, b) { const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o; }
  function camMatrix(w, h) {
    const ar = w / h, near = 0.05, far = 50;
    let P;
    if (opt.proj === "flat") { const s = cam.dist * 0.42; P = new Float32Array([1 / (s * ar), 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]); }
    else { const f = 1 / Math.tan(0.4); P = new Float32Array([f / ar, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]); }
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cx = Math.cos(cam.pitch), sx = Math.sin(cam.pitch);
    const Ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
    const Rx = new Float32Array([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
    const T = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cam.panX, cam.panY, -cam.dist, 1]);
    return mul(P, mul(T, mul(Rx, Ry)));
  }
  const aspVec = () => aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];

  function sizeCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(c.clientWidth * dpr)), h = Math.max(2, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  function draw3D() {
    sizeCanvas(glc);
    gl.viewport(0, 0, glc.width, glc.height);
    const bg = { dark: 0.06, grey: 0.35, light: 0.93 }[opt.bg];
    gl.clearColor(bg, bg, bg + 0.01, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (vD.readyState >= 2) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texD); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vD); }
    const cv = hasSrc ? vS : vD;
    if (cv.readyState >= 2) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texC); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); }
    buildGrid();
    if (opt.spin) cam.yaw += 0.006;
    M = camMatrix(glc.width, glc.height);
    gl.uniformMatrix4fv(U.M, false, M);
    gl.uniform1f(U.S, opt.strength); gl.uniform1f(U.inv, opt.invert ? 1 : 0);
    gl.uniform1f(U.ps, opt.pointSize * Math.min(window.devicePixelRatio || 1, 2));
    gl.uniform2fv(U.asp, aspVec());
    syncLUT();
    const [lo, hi] = limits(), col = (h) => rgb(h).map((x) => x / 255);
    gl.uniform1i(U.mode, opt.color === "distance" ? 1 : 0);
    gl.uniform1i(U.hideOut, opt.dHide ? 1 : 0);
    gl.uniform1f(U.dmix, opt.dMix / 100); gl.uniform1f(U.lo, lo); gl.uniform1f(U.hi, hi);
    gl.uniform1f(U.lines, opt.lines); gl.uniform1f(U.lineW, opt.lineW / 100); gl.uniform3fv(U.lineCol, col(opt.lineCol));
    gl.uniform1f(U.hlOn, opt.hl ? 1 : 0); gl.uniform1f(U.hlPos, opt.hlPos / 100); gl.uniform1f(U.hlW, opt.hlWidth / 200); gl.uniform3fv(U.hlCol, col(opt.hlCol));
    const modeIx = ["off", "behind", "front", "outline"].indexOf(opt.cutMode), pl = planeEq();
    gl.uniform1i(U.cutMode, opt.cutType === "depth" ? modeIx : 0);
    gl.uniform1i(U.planeMode, opt.cutType === "plane" && pl ? modeIx : 0);
    gl.uniform4fv(U.plane, pl || [0, 0, 0, 0]);
    gl.uniform1f(U.cut, opt.cut / 100);
    gl.uniform1f(U.edge, opt.style === "mesh" && opt.edge > 0 ? 0.15 * Math.pow(0.03, opt.edge / 100) : 0);
    gl.uniform2f(U.texel, 1 / (vD.videoWidth || 1280), 1 / (vD.videoHeight || 720));
    gl.uniform1f(U.blurR, opt.edgeBlur); gl.uniform1f(U.soft, opt.edgeSoft);
    gl.uniform1f(U.invF, opt.invert ? 1 : 0); gl.uniform1f(U.SF, opt.strength);
    gl.uniform1f(U.bright, opt.bright);
    gl.bindBuffer(gl.ARRAY_BUFFER, grid.vb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (opt.style === "points") gl.drawArrays(gl.POINTS, 0, grid.verts);
    else if (opt.style === "wire") { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.lb); gl.drawElements(gl.LINES, grid.line, grid.type, 0); }
    else { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.tb); gl.drawElements(gl.TRIANGLES, grid.tri, grid.type, 0); }
  }

  // ---------- stage size ----------
  // Each stage keeps the video's shape and fits inside the pinned area: full column width, capped in height.
  const wide = () => window.matchMedia("(min-width: 960px)").matches;
  function fitStages() {
    const ar = (vD.videoWidth || 16) / (vD.videoHeight || 9);
    const maxH = wide() ? Math.max(240, window.innerHeight - 230) : Math.round(window.innerHeight * 0.42);
    document.documentElement.style.setProperty("--stage-h", maxH + "px");
    for (const id of ["st-stage3d", "st-stage2d"]) {
      const st = $(id), colW = st.parentElement.clientWidth || st.parentElement.parentElement.clientWidth;
      const w = Math.min(colW, maxH * ar);
      st.style.width = Math.floor(w) + "px"; st.style.height = Math.floor(w / ar) + "px";
    }
  }
  window.addEventListener("resize", () => { if (open) fitStages(); });

  // ---------- 3-point cut plane ----------
  let planePts = null;                       // [{u, v, d}] x3, depths locked when the plane was made
  const savePlane = () => clip && store.set("depthpass-plane:" + clip.name, planePts);
  /** Plane through the 3 locked points in the 3D view's space, as [nx, ny, nz, w]; normal faces the camera. */
  function planeEq() {
    if (!planePts) return null;
    const a = aspVec(), P = planePts.map((p) => { const d = opt.invert ? 1 - p.d : p.d; return [(p.u - 0.5) * a[0], (0.5 - p.v) * a[1], (d - 0.5) * opt.strength]; });
    const e1 = [0, 1, 2].map((k) => P[1][k] - P[0][k]), e2 = [0, 1, 2].map((k) => P[2][k] - P[0][k]);
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    if (len < 1e-6) return null;                          // the 3 points are in a line
    n = n.map((x) => x / len * (n[2] < 0 ? -1 : 1));
    return [n[0], n[1], n[2], -(n[0] * P[0][0] + n[1] * P[0][1] + n[2] * P[0][2]) - opt.planeOff / 200];
  }
  /** Rebuild the plane from points 1-3 (their hand-set depths) whenever one of them changes. */
  function syncPlane() {
    if (!planePts) return;
    const pts = points.slice(0, 3);
    if (pts.length < 3 || pts.some((p) => eff(p) == null)) return;
    const prev = planePts;
    planePts = pts.map((p) => ({ u: p.u, v: p.v, d: eff(p) }));
    if (!planeEq()) { planePts = prev; $("st-pmsg").className = "msg bad"; $("st-pmsg").textContent = "Points 1, 2 and 3 are in a straight line, so the plane wasn't changed."; return; }
    savePlane(); clearExports();
  }
  function makePlane() {
    const pts = points.slice(0, 3);
    if (pts.length < 3 || pts.some((p) => eff(p) == null)) return;
    pts.forEach((p) => { if (p.m == null) p.m = p.d; });      // lock depths so a hand passing later can't move the plane
    planePts = pts.map((p) => ({ u: p.u, v: p.v, d: eff(p) }));
    if (!planeEq()) { planePts = null; $("st-pmsg").className = "msg bad"; $("st-pmsg").textContent = "Points 1, 2 and 3 are in a straight line. Spread them out into a triangle."; return; }
    savePoints(); savePlane();
    opt.cutType = "plane"; if (opt.cutMode === "off") opt.cutMode = "behind"; opt.planeOff = 4; saveOpt();
    openGroups.add("Cut plane");
    setTab("3d");
  }

  // ---------- depth sampling for points ----------
  const samp = document.createElement("canvas"); samp.width = 320; samp.height = 180;
  const sctx = samp.getContext("2d", { willReadFrequently: true });
  function sampleDepths() {
    if (!points.length || vD.readyState < 2) return;
    sctx.drawImage(vD, 0, 0, samp.width, samp.height);
    for (const p of points) {
      const x = Math.min(samp.width - 1, Math.floor(p.u * samp.width)), y = Math.min(samp.height - 1, Math.floor(p.v * samp.height));
      p.d = sctx.getImageData(x, y, 1, 1).data[0] / 255;
    }
  }

  // ---------- markers (HTML dots over either stage) ----------
  function placeMarkers(layer, project) {
    while (layer.children.length > points.length) layer.lastChild.remove();
    while (layer.children.length < points.length) layer.appendChild(el("span", "st-dot"));
    points.forEach((p, i) => {
      const m = layer.children[i], pos = project(p);
      m.hidden = !pos; if (!pos) return;
      m.style.left = pos[0] + "px"; m.style.top = pos[1] + "px";
      m.style.background = COLORS[i % COLORS.length]; m.textContent = i + 1;
      m.classList.toggle("sel", i === selected);
    });
  }
  function project3D(p) {
    const e = eff(p);
    if (e == null) return null;
    const a = aspVec(), d = opt.invert ? 1 - e : e;
    const x = (p.u - 0.5) * a[0], y = (0.5 - p.v) * a[1], z = (d - 0.5) * opt.strength;
    const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 0) return null;
    return [(cx / cw * 0.5 + 0.5) * glc.clientWidth, (0.5 - cy / cw * 0.5) * glc.clientHeight];
  }

  // ---------- points tab ----------
  const p2 = $("st-2d"), p2ctx = p2.getContext("2d");
  let checker = null;
  function draw2D() {
    sizeCanvas(p2);
    const v = hasSrc ? vS : vD;
    if (v.readyState < 2) return;
    if (opt.pPreview && sliceSettings() && !sliceRec && initSliceGL()) {
      const W = p2.width, H = p2.height;
      if (opt.pHidden === "checker") {
        if (!checker) { const c = document.createElement("canvas"); c.width = c.height = 24; const x = c.getContext("2d");
          x.fillStyle = "#666"; x.fillRect(0, 0, 24, 24); x.fillStyle = "#999"; x.fillRect(0, 0, 12, 12); x.fillRect(12, 12, 12, 12); checker = p2ctx.createPattern(c, "repeat"); }
        p2ctx.fillStyle = checker; p2ctx.fillRect(0, 0, W, H);
      } else {
        p2ctx.fillStyle = "#000"; p2ctx.fillRect(0, 0, W, H);
        if (opt.pHidden === "dim") { p2ctx.globalAlpha = 0.25; p2ctx.drawImage(v, 0, 0, W, H); p2ctx.globalAlpha = 1; }
      }
      drawSlice(0, Math.min(1, W / (vD.videoWidth || W)));
      p2ctx.drawImage(scv, 0, 0, W, H);
    } else {
      p2ctx.drawImage(v, 0, 0, p2.width, p2.height);
    }
  }
  const pointGroups = () => [
    ["Cut preview", [
      ["toggle", "pPreview", "Show the cut on this view"],
      ...(!opt.pPreview ? [] : [
        ["seg", "cutType", "Cut by", [["depth", "One distance"], ["plane", "3-point plane"]]],
        ...(opt.cutType === "plane" && !planePts ? [["note", "No plane yet. Add 3 points on the wall and tap Make a cut plane below."]] : []),
        ["seg", "cutMode", "Remove", [["off", "Nothing"], ["behind", "Behind"], ["front", "In front"]]],
        opt.cutType === "plane" ? ["range", "planeOff", "Nudge the plane (back to front)", -40, 40, 1] : ["range", "cut", "Position (far to near)", 0, 100, 1],
        ["range", "edgeBlur", "Edge smoothing", 0, 8, 0.5],
        ["range", "edgeSoft", "Edge softness", 0, 8, 0.5],
        ["seg", "pHidden", "Show removed parts as", [["checker", "Checkerboard"], ["dim", "Dimmed"], ["black", "Black"]]],
      ]),
    ]],
  ];
  function buildPointOptions() {
    const root = $("st-pcut"); root.innerHTML = "";
    openGroups.add("Cut preview");
    renderGroups(root, pointGroups());
  }
  function renderPointList() {
    const list = $("st-plist"); list.innerHTML = "";
    $("st-pempty").hidden = points.length > 0;
    $("st-pclear").hidden = points.length === 0;
    $("st-pplane").hidden = points.length < 3 || !!planePts; $("st-pmsg").textContent = "";
    points.forEach((p, i) => {
      const row = el("div", "st-prow" + (i === selected ? " sel" : ""));
      const dot = el("span", "st-dot static", i + 1); dot.style.background = COLORS[i % COLORS.length];
      const mid = el("div", "st-pmid");
      const val = el("span", "st-pval"); val.dataset.i = i;
      const bar = el("div", "bar"); bar.appendChild(el("i")); bar.firstChild.dataset.i = i;
      mid.append(val, bar);
      const cut = el("button", "secondary small", "Cut here");
      cut.onclick = () => { if (eff(p) == null) return; opt.cutType = "depth"; opt.cut = Math.round(eff(p) * 100); if (opt.cutMode === "off") opt.cutMode = "behind"; saveOpt(); buildOptions(); setTab("3d"); };
      const rm = el("button", "secondary small", "Remove");
      rm.onclick = () => { points.splice(i, 1); selected = -1; savePoints(); if (planePts && i < 3) syncPlane(); renderPointList(); };
      const adj = el("button", "secondary small", i === selected ? "Done" : "Adjust");
      adj.onclick = () => { selected = i === selected ? -1 : i; renderPointList(); };
      const btns = el("div", "st-pbtns"); btns.append(adj, cut, rm);
      row.append(dot, mid, btns);
      if (i === selected) row.appendChild(adjustPanel(p, i));
      list.appendChild(row);
    });
    updatePointValues();
  }
  /** Sliders for one point: left-right, up-down, and depth (set by hand, or read from the video). */
  function adjustPanel(p, i) {
    const box = el("div", "st-padj");
    const changed = () => { savePoints(); if (planePts && i < 3) syncPlane(); updatePointValues(); };
    const slider = (label, get, set, id) => {
      const f = el("div", "st-field"), head = el("div", "st-rhead"), v = el("span", "st-rval");
      const lab = el("label", "st-label", label); lab.htmlFor = id;
      const r = el("input"); r.type = "range"; r.min = 0; r.max = 100; r.step = 0.1; r.id = id;
      const show = () => { const x = get(); r.value = x == null ? 50 : x * 100; v.textContent = x == null ? "…" : (x * 100).toFixed(1); };
      r.oninput = () => { set(+r.value / 100); show(); changed(); };
      head.append(lab, v); f.append(head, r); show();
      f.refresh = show;
      return f;
    };
    const sx = slider("Left ↔ right", () => p.u, (x) => { p.u = x; p.d = null; }, `padj-x-${i}`);
    const sy = slider("Up ↕ down", () => p.v, (x) => { p.v = x; p.d = null; }, `padj-y-${i}`);
    const sd = slider("Far ↔ near (depth)", () => eff(p), (x) => { p.m = x; }, `padj-d-${i}`);
    const reset = el("button", "secondary small", "Use video depth here");
    reset.onclick = () => { if (p.d == null) return; p.m = planePts && i < 3 ? p.d : null; sd.refresh(); changed(); };
    box.append(sx, sy, sd, reset);
    return box;
  }
  function updatePointValues() {
    document.querySelectorAll("#st-plist .st-pval").forEach((s) => {
      const p = points[+s.dataset.i]; if (!p) return;
      const d = eff(p);
      s.textContent = d == null ? "…" : `${(d * 100).toFixed(1)}% near${p.m != null ? " (set)" : ""}`;
    });
    document.querySelectorAll("#st-plist .bar > i").forEach((b) => {
      const p = points[+b.dataset.i], d = p && eff(p); if (d != null) b.style.width = `${d * 100}%`;
    });
  }
  const eff = (p) => (p.m != null ? p.m : p.d);
  const savePoints = () => clip && store.set("depthpass-pts:" + clip.name, points.map((p) => ({ u: p.u, v: p.v, m: p.m ?? null })));

  // Tap empty space to add a point; press on a point and drag to move it.
  let tapStart = null, dragging = -1, moved = false;
  const at = (e) => { const r = p2.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r]; };
  p2.addEventListener("pointerdown", (e) => {
    const [u, v, r] = at(e);
    tapStart = [e.clientX, e.clientY]; moved = false;
    dragging = points.findIndex((p) => Math.hypot((p.u - u) * r.width, (p.v - v) * r.height) < 24);
    if (dragging >= 0) { selected = dragging; p2.setPointerCapture(e.pointerId); renderPointList(); }
  });
  p2.addEventListener("pointermove", (e) => {
    if (dragging < 0) return;
    if (!moved && Math.hypot(e.clientX - tapStart[0], e.clientY - tapStart[1]) < 4) return;
    const [u, v] = at(e); moved = true;
    points[dragging].u = u; points[dragging].v = v; points[dragging].d = null; points[dragging].m = null;
  });
  const endDrag = (e) => {
    if (dragging >= 0) {
      const i = dragging; dragging = -1;
      if (moved) {
        savePoints(); renderPointList();
        if (planePts && i < 3) setTimeout(() => { points[i].m = points[i].d; savePoints(); syncPlane(); renderPointList(); }, 120);   // read the new spot's depth first
      }
      return;
    }
    if (!tapStart || Math.hypot(e.clientX - tapStart[0], e.clientY - tapStart[1]) > 8) return;
    const [u, v] = at(e);
    if (points.length < 8) { points.push({ u, v, d: null }); selected = points.length - 1; savePoints(); }
    renderPointList();
  };
  p2.addEventListener("pointerup", endDrag);
  p2.addEventListener("pointercancel", () => { dragging = -1; });
  $("st-pplane").onclick = makePlane;
  $("st-pclear").onclick = () => { points = []; selected = -1; savePoints(); renderPointList(); };

  // ---------- 3D gestures ----------
  const ptrs = new Map(); let pinch = null;
  glc.addEventListener("pointerdown", (e) => { glc.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); pinch = null; });
  glc.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) {
      cam.yaw += (e.clientX - prev[0]) * 0.008;
      cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch + (e.clientY - prev[1]) * 0.008));
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (pinch) {
        cam.dist = Math.max(0.5, Math.min(8, cam.dist * pinch.dist / dist));
        cam.panX += (mid[0] - pinch.mid[0]) * 0.0025 * cam.dist; cam.panY -= (mid[1] - pinch.mid[1]) * 0.0025 * cam.dist;
      }
      pinch = { dist, mid };
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch = null; };
  glc.addEventListener("pointerup", up); glc.addEventListener("pointercancel", up);
  glc.addEventListener("wheel", (e) => { e.preventDefault(); cam.dist = Math.max(0.5, Math.min(8, cam.dist * (1 + e.deltaY * 0.001))); }, { passive: false });
  const VIEWS = { Front: [0, 0], Angle: [0.5, 0.25], Side: [1.5, 0], Top: [0, 1.55] };
  function setView(name) { [cam.yaw, cam.pitch] = VIEWS[name]; cam.panX = cam.panY = 0; cam.dist = 1.45; opt.spin = false; saveOpt(); buildOptions(); }

  // ---------- transport ----------
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}.${String(Math.floor((t % 1) * 10))}`;
  function seek(t) { const d = master.duration || 0; t = Math.max(0, Math.min(d - 0.001, t)); vD.currentTime = t; if (hasSrc) vS.currentTime = t; }
  function playing() { return !master.paused; }
  async function setPlaying(on) {
    try {
      if (on) { vD.playbackRate = vS.playbackRate = opt.speed; await Promise.all([vD.play(), hasSrc ? vS.play() : null]); }
      else { vD.pause(); vS.pause(); seek(master.currentTime); }
    } catch {}
    $("st-play").textContent = playing() ? "Pause" : "Play";
  }
  $("st-play").onclick = () => setPlaying(!playing());
  $("st-prev").onclick = () => { setPlaying(false); seek(master.currentTime - 1 / 30); };
  $("st-next").onclick = () => { setPlaying(false); seek(master.currentTime + 1 / 30); };
  let scrubbing = false;
  $("st-scrub").addEventListener("input", () => { scrubbing = true; seek(($("st-scrub").value / 1000) * (master.duration || 0)); });
  $("st-scrub").addEventListener("change", () => { scrubbing = false; });

  // ---------- options UI ----------
  const distanceGroups = () => [
      ["Distance colours", [
        ["seg", "dPalette", "Palette", [["grey", "Grey"], ["turbo", "Turbo"], ["heat", "Heat"], ["viridis", "Viridis"], ["magma", "Magma"], ["ocean", "Ocean"], ["custom", "My colours"]]],
        ...(opt.dPalette !== "custom" ? [] : [["color", "dFarCol", "Far colour"], ["color", "dMidCol", "Middle colour"], ["color", "dNearCol", "Near colour"]]),
        ["toggle", "dFlip", "Reverse the palette"],
        ["range", "dMix", "Blend with video (0 = video only)", 0, 100, 5],
        ["range", "dSteps", "Colour steps (0 = smooth)", 0, 24, 1],
        ["range", "dGamma", "Curve (below 1 spreads far, above 1 spreads near)", 0.3, 3, 0.05],
      ]],
      ["Distance range", [
        ["note", "Spend the whole palette on just the distances you care about."],
        ["range", "dLo", "Far limit", 0, 100, 1],
        ["range", "dHi", "Near limit", 0, 100, 1],
        ["toggle", "dHide", "Hide everything outside the limits"],
      ]],
      ["Contour lines", [
        ["range", "lines", "Number of lines (0 = off)", 0, 40, 1],
        ["range", "lineW", "Line thickness", 5, 50, 5],
        ["color", "lineCol", "Line colour"],
      ]],
      ["Highlight a distance", [
        ["toggle", "hl", "Highlight one distance"],
        ...(!opt.hl ? [] : [["range", "hlPos", "Distance (far to near)", 0, 100, 1], ["range", "hlWidth", "Band width", 1, 20, 1], ["color", "hlCol", "Highlight colour"]]),
      ]],
    
  ];
  const groups = () => [
    ["Shape", [
      ["seg", "style", "Draw as", [["mesh", "Surface"], ["points", "Dots"], ["wire", "Wireframe"]]],
      ["range", "strength", "Depth strength", 0, 2, 0.05],
      ["seg", "density", "Detail", [[160, "Low"], [240, "Medium"], [320, "High"], ...(uint32 ? [[480, "Very high"], [640, "Max"]] : [])]],
      ["range", "pointSize", "Dot size", 1, 8, 0.5],
      ["range", "edge", "Hide stretched edges", 0, 100, 5],
      ["range", "edgeBlur", "Edge smoothing (blurs the steps in cut outlines)", 0, 8, 0.5],
      ["range", "edgeSoft", "Edge softness (feathers cut edges)", 0, 8, 0.5],
      ["toggle", "invert", "Flip near and far"],
    ]],
    ["Colour", [
      ["seg", "color", "Colour from", [["video", "Video"], ["distance", "Distance colours"]]],
      ["range", "bright", "Brightness", 0.5, 1.5, 0.05],
      ["seg", "bg", "Background", [["dark", "Dark"], ["grey", "Grey"], ["light", "Light"]]],
    ]],
    ...(opt.color !== "distance" ? [] : distanceGroups()),
    ["Cut plane", [
      ["seg", "cutType", "Cut by", [["depth", "One distance"], ["plane", "3-point plane"]]],
      ...(opt.cutType === "plane"
        ? (planePts
          ? [["note", "Cuts along the plane through your 3 points. Tilted walls work too. It starts nudged slightly forward so the wall itself is removed cleanly; slide to 0 to put it exactly on the wall."],
             ["seg", "cutMode", "Mode", [["off", "Off"], ["behind", "Hide behind"], ["front", "Hide in front"], ["outline", "Outline only"]]],
             ["range", "planeOff", "Nudge the plane (back to front)", -40, 40, 1],
             ["buttons", "Plane", ["Remove plane"], () => { planePts = null; savePlane(); opt.cutType = "depth"; saveOpt(); buildOptions(); }]]
          : [["note", "No plane yet. In the Points tab, tap 3 spots on the wall, then tap Make a cut plane."]])
        : [["note", "Slices the scene at one distance. Tip: map a point on the wall, then tap Cut here."],
           ["seg", "cutMode", "Mode", [["off", "Off"], ["behind", "Hide behind"], ["front", "Hide in front"], ["outline", "Outline only"]]],
           ["range", "cut", "Position (far to near)", 0, 100, 1]]),
    ]],
    ["Camera", [
      ["buttons", "View", Object.keys(VIEWS), setView],
      ["seg", "proj", "Lens", [["perspective", "Perspective"], ["flat", "Flat (no perspective)"]]],
      ["toggle", "spin", "Slowly rotate"],
    ]],
    ["Playback", [
      ["seg", "speed", "Speed", [[0.25, "¼×"], [0.5, "½×"], [1, "1×"]]],
      ["toggle", "loop", "Loop"],
    ]],
  ];
  const openGroups = new Set(["Shape"]);
  function applyOpt(key) {
    saveOpt();
    if (!recording) clearRecording();
    if (!sliceRec) clearExports();
    if (key === "speed") vD.playbackRate = vS.playbackRate = opt.speed;
    if (key === "loop") vD.loop = vS.loop = opt.loop;
  }
  function buildOptions() {
    if (tab === "watch") return buildWatchOptions();
    if (tab === "points") return buildPointOptions();
    const root = $("st-options"); root.innerHTML = "";
    $("st-legend").hidden = opt.color !== "distance";
    renderGroups(root, groups());
    const reset = el("button", "secondary", "Reset all options");
    reset.onclick = () => { opt = { ...DEFAULTS }; applyOpt("speed"); applyOpt("loop"); setView("Angle"); };
    root.appendChild(reset);
  }
  function buildWatchOptions() {
    const root = $("st-woptions"); root.innerHTML = "";
    renderGroups(root, distanceGroups());
  }
  function renderGroups(root, list) {
    for (const [title, items] of list) {
      const det = el("details", "st-group"); det.open = openGroups.has(title);
      det.addEventListener("toggle", () => { det.open ? openGroups.add(title) : openGroups.delete(title); });
      det.appendChild(el("summary", null, title));
      const body = el("div", "st-gbody");
      for (const it of items) {
        const [kind, key, label] = it;
        const field = el("div", "st-field");
        if (kind === "note") { field.appendChild(el("p", "muted", key)); }
        else if (kind === "seg" || kind === "buttons") {
          field.appendChild(el("span", "st-label", kind === "buttons" ? key : label));
          const seg = el("div", "st-seg");
          const choices = kind === "buttons" ? it[2].map((n) => [n, n]) : it[3];
          for (const [val, text] of choices) {
            const b = el("button", null, text);
            if (kind === "seg") b.setAttribute("aria-pressed", String(opt[key] === val));
            b.onclick = () => { if (kind === "buttons") it[3](val); else { opt[key] = val; applyOpt(key); buildOptions(); } };
            seg.appendChild(b);
          }
          field.appendChild(seg);
        } else if (kind === "range") {
          const head = el("div", "st-rhead"); const val = el("span", "st-rval", String(opt[key]));
          head.append(el("label", "st-label", label), val);
          const r = el("input"); r.type = "range"; r.min = it[3]; r.max = it[4]; r.step = it[5]; r.value = opt[key];
          r.id = "opt-" + key; head.firstChild.htmlFor = r.id;
          r.oninput = () => { opt[key] = +r.value; val.textContent = r.value; applyOpt(key); };
          field.append(head, r);
        } else if (kind === "color") {
          const lab = el("label", "st-toggle"); const c = el("input"); c.type = "color"; c.value = opt[key]; c.id = "opt-" + key;
          c.oninput = () => { opt[key] = c.value; applyOpt(key); };
          lab.append(c, el("span", null, label)); field.appendChild(lab);
        } else if (kind === "toggle") {
          const lab = el("label", "st-toggle"); const c = el("input"); c.type = "checkbox"; c.checked = !!opt[key]; c.id = "opt-" + key;
          c.onchange = () => { opt[key] = c.checked; applyOpt(key); if (key === "hl" || key === "pPreview") buildOptions(); };
          lab.append(c, el("span", null, label)); field.appendChild(lab);
        }
        body.appendChild(field);
      }
      det.appendChild(body); root.appendChild(det);
    }
  }

  // ---------- coloured depth video (Watch tab) ----------
  const ccv = $("st-color");
  let cgl = null, cU = {}, cTexD = null, cTexC = null, cTexL = null;
  const lutW = { sig: "" };
  // Full-screen quad; v = image coordinates with (0,0) at the top-left, matching how video frames are uploaded.
  const QUAD_VS = "attribute vec2 a; varying vec2 v; void main(){ v = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); gl_Position = vec4(a, 0.0, 1.0); }";
  const CFS = (d) => `${AA(d)}precision mediump float;
uniform sampler2D D, C, L; uniform int hideOut;
uniform float dmix, lo, hi, lines, lineW, hlOn, hlPos, hlW, inv; uniform vec3 lineCol, hlCol;
varying vec2 v;
void main(){
  float vd = texture2D(D, v).r; if (inv > 0.5) vd = 1.0 - vd;
  vec3 c = mix(texture2D(C, v).rgb, texture2D(L, vec2(vd, 0.5)).rgb, dmix);
  float fv = FW(vd);
  if (hideOut == 1) c *= smoothstep(-fv, fv, vd - lo) * smoothstep(-fv, fv, hi - vd);
  float u = (vd - lo) / max(hi - lo, 0.001);
  if (lines > 0.0 && u > 0.0 && u < 1.0) {
    float t = u * lines, dl = abs(t - floor(t + 0.5)), fw = FW(t);
    c = mix(c, lineCol, 1.0 - smoothstep(lineW * 0.5 - fw, lineW * 0.5 + fw, dl));
  }
  if (hlOn > 0.5) c = mix(c, hlCol, 0.85 * (1.0 - smoothstep(hlW - fv, hlW + fv, abs(vd - hlPos))));
  gl_FragColor = vec4(c, 1.0); }`;
  function initColorGL() {
    if (cgl) return true;
    cgl = ccv.getContext("webgl", { preserveDrawingBuffer: true, alpha: false });
    if (!cgl) return false;
    const g = cgl, sh = (type, src) => { const x = g.createShader(type); g.shaderSource(x, src); g.compileShader(x);
      if (!g.getShaderParameter(x, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(x)); return x; };
    const pr = g.createProgram();
    g.attachShader(pr, sh(g.VERTEX_SHADER, QUAD_VS));
    g.attachShader(pr, sh(g.FRAGMENT_SHADER, CFS(!!g.getExtension("OES_standard_derivatives"))));
    g.bindAttribLocation(pr, 0, "a"); g.linkProgram(pr); g.useProgram(pr);
    for (const n of ["D", "C", "L", "hideOut", "dmix", "lo", "hi", "lines", "lineW", "hlOn", "hlPos", "hlW", "inv", "lineCol", "hlCol"]) cU[n] = g.getUniformLocation(pr, n);
    const tex = (unit) => { const t = g.createTexture(); g.activeTexture(g.TEXTURE0 + unit); g.bindTexture(g.TEXTURE_2D, t);
      for (const [k, val] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, val);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255])); return t; };
    cTexD = tex(0); cTexC = tex(1); cTexL = tex(2); lutW.sig = "";
    g.uniform1i(cU.D, 0); g.uniform1i(cU.C, 1); g.uniform1i(cU.L, 2);
    const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    return true;
  }
  function drawColor() {
    const g = cgl;
    if (ccv.width !== vD.videoWidth || ccv.height !== vD.videoHeight) { ccv.width = vD.videoWidth || 2; ccv.height = vD.videoHeight || 2; }
    g.viewport(0, 0, ccv.width, ccv.height);
    if (vD.readyState >= 2) { g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, cTexD); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, vD); }
    const cv = hasSrc ? vS : vD;
    if (cv.readyState >= 2) { g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, cTexC); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, cv); }
    uploadLUT(g, cTexL, lutW);
    const [lo, hi] = limits(), col = (h) => rgb(h).map((x) => x / 255);
    g.uniform1i(cU.hideOut, opt.dHide ? 1 : 0); g.uniform1f(cU.inv, opt.invert ? 1 : 0);
    g.uniform1f(cU.dmix, hasSrc ? opt.dMix / 100 : 1); g.uniform1f(cU.lo, lo); g.uniform1f(cU.hi, hi);
    g.uniform1f(cU.lines, opt.lines); g.uniform1f(cU.lineW, opt.lineW / 100); g.uniform3fv(cU.lineCol, col(opt.lineCol));
    g.uniform1f(cU.hlOn, opt.hl ? 1 : 0); g.uniform1f(cU.hlPos, opt.hlPos / 100); g.uniform1f(cU.hlW, opt.hlWidth / 200); g.uniform3fv(cU.hlCol, col(opt.hlCol));
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  let watchKind = "depth";
  const coloured = () => tab === "watch" && watchKind === "color";

  // Save the coloured version: play the clip once from the start while recording the canvas.
  let recorded = null, recording = false;
  async function exportColoured() {
    const btn = $("st-wexport"), msg = $("st-wexpmsg");
    if (recorded) {                                          // second tap: hand the file to the share sheet
      try {
        if (navigator.canShare && navigator.canShare({ files: [recorded] })) await navigator.share({ files: [recorded] });
        else { const a = document.createElement("a"); a.href = URL.createObjectURL(recorded); a.download = recorded.name; document.body.appendChild(a); a.click(); a.remove(); }
      } catch {}
      return;
    }
    if (recording || !ccv.captureStream || typeof MediaRecorder === "undefined") {
      if (!recording) { msg.className = "msg bad"; msg.textContent = "This browser can't record video from the page."; }
      return;
    }
    const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) { msg.className = "msg bad"; msg.textContent = "This browser can't record video from the page."; return; }
    recording = true; btn.disabled = true; msg.className = "msg"; msg.textContent = "Recording… let the clip play through once.";
    const chunks = [], rec = new MediaRecorder(ccv.captureStream(30), { mimeType: type, videoBitsPerSecond: 12e6 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const wasLoop = opt.loop, wasSpeed = opt.speed;
    vD.loop = vS.loop = false; vD.playbackRate = vS.playbackRate = 1;
    await setPlaying(false); seek(0);
    await new Promise((r) => setTimeout(r, 300));
    rec.start(250); await setPlaying(true);
    await new Promise((res) => { master.onended = res; });
    master.onended = null;
    rec.stop(); await new Promise((r) => { rec.onstop = r; });
    vD.loop = vS.loop = wasLoop; vD.playbackRate = vS.playbackRate = wasSpeed;
    const ext = type.includes("mp4") ? "mp4" : "webm";
    recorded = new File(chunks, `${(clip && clip.title) || "depth"}_coloured.${ext}`, { type: type.split(";")[0] });
    recording = false; btn.disabled = false;
    btn.textContent = "Ready. Tap again to save";
    msg.className = "msg ok"; msg.textContent = `Recorded (${(recorded.size / 1048576).toFixed(1)} MB). Changing a colour setting clears it.`;
  }
  $("st-wexport").onclick = exportColoured;
  const clearRecording = () => { if (recorded) { recorded = null; $("st-wexport").textContent = "Save coloured video"; $("st-wexpmsg").textContent = ""; } };

  // ---------- export the slice (what the cut keeps) ----------
  const scv = $("st-slice");
  let sgl = null, sU = {}, sTexD = null, sTexC = null, sliceRec = false;
  const SFS = (d) => `${AA(d)}precision mediump float;${EDGE_GLSL}
uniform sampler2D C; uniform int ctype, cmode, outMode; uniform float cut, S; uniform vec2 asp; uniform vec4 plane;
varying vec2 v;
void main(){
  float vd = blurDepth(v).x;
  vec3 vp = vec3((v.x - 0.5) * asp.x, (0.5 - v.y) * asp.y, (vd - 0.5) * S);
  float a = 1.0, pd = dot(plane.xyz, vp) + plane.w;
  if (ctype == 0) { if (cmode == 1) a = keep(vd - cut); if (cmode == 2) a = keep(cut - vd); }
  else { if (cmode == 1) a = keep(pd); if (cmode == 2) a = keep(-pd); }
  vec3 c = texture2D(C, v).rgb;
  gl_FragColor = outMode == 1 ? vec4(vec3(a), 1.0) : vec4(c, a); }`;
  function initSliceGL() {
    if (sgl) return true;
    sgl = scv.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!sgl) return false;
    const g = sgl, sh = (type, src) => { const x = g.createShader(type); g.shaderSource(x, src); g.compileShader(x);
      if (!g.getShaderParameter(x, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(x)); return x; };
    const pr = g.createProgram();
    g.attachShader(pr, sh(g.VERTEX_SHADER, QUAD_VS));
    g.attachShader(pr, sh(g.FRAGMENT_SHADER, SFS(!!g.getExtension("OES_standard_derivatives"))));
    g.bindAttribLocation(pr, 0, "a"); g.linkProgram(pr); g.useProgram(pr);
    for (const n of ["D", "C", "ctype", "cmode", "outMode", "cut", "S", "asp", "plane", "texel", "blurR", "invF", "soft"]) sU[n] = g.getUniformLocation(pr, n);
    const tex = (unit) => { const t = g.createTexture(); g.activeTexture(g.TEXTURE0 + unit); g.bindTexture(g.TEXTURE_2D, t);
      for (const [k, val] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, val);
      return t; };
    sTexD = tex(0); sTexC = tex(1);
    g.uniform1i(sU.D, 0); g.uniform1i(sU.C, 1);
    const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    return true;
  }
  /** What the current cut settings keep, or null when no cut is set up. */
  function sliceSettings() {
    const mode = ["off", "behind", "front", "outline"].indexOf(opt.cutMode);
    if (mode !== 1 && mode !== 2) return null;
    if (opt.cutType === "plane") { const pl = planeEq(); return pl ? { ctype: 1, cmode: mode, plane: pl } : null; }
    return { ctype: 0, cmode: mode, plane: [0, 0, 0, 0] };
  }
  function drawSlice(outMode, scale) {
    const g = sgl, st = sliceSettings() || { ctype: 0, cmode: 0, plane: [0, 0, 0, 0] };
    const w = Math.max(2, Math.round((vD.videoWidth || 2) * scale / 2) * 2), h = Math.max(2, Math.round((vD.videoHeight || 2) * scale / 2) * 2);
    if (scv.width !== w || scv.height !== h) { scv.width = w; scv.height = h; }
    g.viewport(0, 0, w, h);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, sTexD); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, vD);
    g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, sTexC); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, hasSrc ? vS : vD);
    g.uniform1i(sU.ctype, st.ctype); g.uniform1i(sU.cmode, st.cmode); g.uniform1i(sU.outMode, outMode);
    g.uniform1f(sU.cut, opt.cut / 100); g.uniform1f(sU.S, opt.strength); g.uniform1f(sU.invF, opt.invert ? 1 : 0);
    g.uniform2f(sU.texel, 1 / (vD.videoWidth || 1280), 1 / (vD.videoHeight || 720));
    g.uniform1f(sU.blurR, opt.edgeBlur); g.uniform1f(sU.soft, opt.edgeSoft * scale);
    g.uniform2fv(sU.asp, aspVec()); g.uniform4fv(sU.plane, st.plane);
    g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  const seekBoth = (t) => Promise.all([vD, ...(hasSrc ? [vS] : [])].map((v) => new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done); v.currentTime = t; setTimeout(done, 3000);
  })));
  async function shareFile(file) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else { const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    } catch {}
  }
  const loadZip = () => window.JSZip ? Promise.resolve() : new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    sc.onload = res; sc.onerror = () => rej(new Error("Couldn't load the zip tool.")); document.head.appendChild(sc);
  });
  const ready = {};                                         // finished exports waiting for the second tap
  /** Run one export. kind: "png" (transparent PNG frames, zip), "webm" (transparent video), "mask" (MP4 matte). */
  async function exportSlice(kind, btn) {
    const msg = $("st-xmsg"), label = btn.dataset.label;
    if (ready[kind]) { await shareFile(ready[kind]); return; }
    if (!sliceSettings()) { msg.className = "msg bad"; msg.textContent = "Set up a cut first: in 3D, open Cut plane and choose Hide behind or Hide in front."; return; }
    if (sliceRec) return;
    if (!initSliceGL()) { msg.className = "msg bad"; msg.textContent = "This browser couldn't start the export."; return; }
    const base = `${(clip && clip.title) || "clip"}_slice`, scale = $("st-xhalf").checked ? 0.5 : 1;
    document.querySelectorAll("#st-xbtns button").forEach((b) => { b.disabled = true; });
    msg.className = "msg";
    try {
      if (kind === "png") {
        await loadZip();
        const zip = new JSZip(), fps = 30, n = clip.png ? 1 : Math.max(1, Math.round((master.duration || 0) * fps));
        await setPlaying(false);
        for (let i = 0; i < n; i++) {
          if (!clip.png) await seekBoth(Math.min((i + 0.5) / fps, (master.duration || 0) - 0.001));
          drawSlice(0, scale);
          const blob = await new Promise((r) => scv.toBlob(r, "image/png"));
          zip.file(`${base}_${String(i).padStart(5, "0")}.png`, blob);
          msg.textContent = `Making frame ${i + 1} of ${n}…`;
        }
        if (n === 1) ready[kind] = new File([await new Promise((r) => scv.toBlob(r, "image/png"))], `${base}.png`, { type: "image/png" });
        else { msg.textContent = "Packing the zip…"; ready[kind] = new File([await zip.generateAsync({ type: "blob", compression: "STORE" })], `${base}_png.zip`, { type: "application/zip" }); }
      } else {
        const types = kind === "webm" ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] : ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
        const type = typeof MediaRecorder !== "undefined" && scv.captureStream ? types.find((t) => MediaRecorder.isTypeSupported(t)) : null;
        if (!type) throw new Error(kind === "webm" ? "This browser can't record transparent video. Use Transparent PNG frames instead." : "This browser can't record video from the page.");
        if (clip.png) {                                       // a photo: one still frame, no recording needed
          drawSlice(kind === "mask" ? 1 : 0, scale);
          ready[kind] = new File([await new Promise((r) => scv.toBlob(r, "image/png"))], `${base}${kind === "mask" ? "_mask" : ""}.png`, { type: "image/png" });
        } else {
          drawSlice(kind === "mask" ? 1 : 0, scale);
          const chunks = [], rec = new MediaRecorder(scv.captureStream(30), { mimeType: type, videoBitsPerSecond: 12e6 });
          rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
          const wasLoop = opt.loop, wasSpeed = opt.speed;
          vD.loop = vS.loop = false; vD.playbackRate = vS.playbackRate = 1;
          await setPlaying(false); await seekBoth(0);
          sliceRec = { out: kind === "mask" ? 1 : 0, scale };
          msg.textContent = "Recording… the clip plays through once.";
          rec.start(250); await setPlaying(true);
          await new Promise((res) => { master.onended = res; });
          master.onended = null; sliceRec = false;
          rec.stop(); await new Promise((r) => { rec.onstop = r; });
          vD.loop = vS.loop = wasLoop; vD.playbackRate = vS.playbackRate = wasSpeed;
          const ext = type.includes("mp4") ? "mp4" : "webm";
          ready[kind] = new File(chunks, `${base}${kind === "mask" ? "_mask" : ""}.${ext}`, { type: type.split(";")[0] });
        }
      }
      btn.textContent = "Ready. Tap again to save";
      msg.className = "msg ok"; msg.textContent = `Done (${(ready[kind].size / 1048576).toFixed(1)} MB). Changing the cut clears finished exports.`;
    } catch (e) {
      sliceRec = false; msg.className = "msg bad"; msg.textContent = e.message || String(e); btn.textContent = label;
    } finally {
      document.querySelectorAll("#st-xbtns button").forEach((b) => { b.disabled = false; });
    }
  }
  function clearExports() {
    for (const k of Object.keys(ready)) delete ready[k];
    document.querySelectorAll("#st-xbtns button").forEach((b) => { b.textContent = b.dataset.label; });
  }
  document.querySelectorAll("#st-xbtns button").forEach((b) => { b.dataset.label = b.textContent; b.onclick = () => exportSlice(b.dataset.kind, b); });

  // ---------- loop ----------
  function frame() {
    raf = 0;
    if (!open) return;
    if (sliceRec && sgl) drawSlice(sliceRec.out, sliceRec.scale);
    if (tab === "3d" || tab === "points" || coloured()) {
      if (hasSrc && Math.abs(vD.currentTime - vS.currentTime) > 0.07) vD.currentTime = vS.currentTime;
      sampleDepths();
      if (coloured()) { if (cgl) drawColor(); }
      else if (tab === "3d") { draw3D(); placeMarkers($("st-m3d"), project3D); }
      else { draw2D(); placeMarkers($("st-m2d"), (p) => [p.u * p2.clientWidth, p.v * p2.clientHeight]); updatePointValues(); }
      const d = master.duration || 0;
      if (!scrubbing && d) $("st-scrub").value = (master.currentTime / d) * 1000;
      $("st-time").textContent = `${fmt(master.currentTime)} / ${fmt(d)}`;
      if (!playing()) $("st-play").textContent = "Play";
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- tabs ----------
  function setTab(t) {
    tab = t;
    document.querySelectorAll("#st-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === t)));
    for (const name of ["watch", "3d", "points", "files"]) $("pane-" + name).hidden = name !== t;
    $("pane-3d-options").hidden = t !== "3d"; $("pane-points-list").hidden = t !== "points";
    $("st-wcolor-opts").hidden = !(t === "watch" && watchKind === "color");
    const colour = t === "watch" && watchKind === "color";
    $("st-transport").hidden = !(t === "3d" || t === "points" || colour) || !!(clip && clip.png);
    const w = $("st-watch");
    if (t !== "watch" || colour) w.pause();
    if (t !== "3d" && t !== "points" && !colour) setPlaying(false);
    if (colour) {
      try { if (!initColorGL()) throw new Error("no webgl"); } catch { $("st-wexpmsg").className = "msg bad"; $("st-wexpmsg").textContent = "This browser couldn't start the colour view."; }
      buildWatchOptions();
      if (master.readyState < 2) seek(0.001);
    }
    if (t === "3d") {
      try { if (!initGL()) throw new Error("no webgl"); $("st-glmsg").hidden = true; }
      catch (e) { $("st-glmsg").hidden = false; $("st-glmsg").textContent = "This browser couldn't start 3D graphics."; }
      buildOptions();
    }
    if (t === "points") { renderPointList(); buildPointOptions(); }
    if ((t === "3d" || t === "points") && master.readyState < 2) seek(0.001);
    if (!raf) raf = requestAnimationFrame(frame);
    requestAnimationFrame(fitStages);
  }
  document.querySelectorAll("#st-tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

  // ---------- open / close ----------
  async function openClip(c) {
    clip = c; open = true;
    document.querySelector("main").hidden = true; $("studio").hidden = false; window.scrollTo(0, 0);
    $("st-title").textContent = c.title; $("st-when").textContent = c.when || "";
    $("st-status").hidden = false; $("st-status").className = "msg"; $("st-status").textContent = "Loading videos…";
    $("st-main").hidden = true;
    hasSrc = !!c.src;
    master = hasSrc ? vS : vD;
    points = store.get("depthpass-pts:" + c.name, []).map((p) => ({ u: p.u, v: p.v, m: p.m ?? null, d: null })); selected = -1;
    planePts = store.get("depthpass-plane:" + c.name, null);
    try {
      const [fd, fs] = await Promise.all([DP.getFile(c.depth.path, c.depth.name), hasSrc ? DP.getFile(c.src.path, c.src.name) : null]);
      if (clip !== c) return;
      const ud = DP.urlFor(c.depth.path, fd), us = fs ? DP.urlFor(c.src.path, fs) : null;
      const ready = (v, u) => new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("This browser couldn't play the video.")); v.src = u; v.load(); });
      await Promise.all([ready(vD, ud), us ? ready(vS, us) : null]);
      if (clip !== c) return;
      aspect = (vD.videoWidth || 16) / (vD.videoHeight || 9);
      samp.height = Math.round(samp.width / aspect);
      fitStages();
      vD.loop = vS.loop = opt.loop;
      // Watch tab
      const w = $("st-watch"); watchKind = "depth"; clearRecording();
      $("st-wseg").querySelector('[data-kind="src"]').hidden = !us;
      const showWatch = () => {
        const colour = watchKind === "color";
        w.hidden = colour; $("st-wcolor").hidden = !colour;
        if (!colour) { const want = watchKind === "depth" ? ud : us; if (w.src !== want) w.src = want; }
        document.querySelectorAll("#st-wseg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === watchKind)));
        setTab("watch");
      };
      document.querySelectorAll("#st-wseg button").forEach((b) => { b.onclick = () => { watchKind = b.dataset.kind; showWatch(); }; });
      showWatch();
      // Files tab
      const files = $("st-files"); files.innerHTML = ""; clearExports(); $("st-xmsg").textContent = "";
      $("st-xhalf").checked = !wide();
      const saves = c.png
        ? [[c.png, "Save depth image (16-bit PNG)", ""], [c.pngSrc, "Save matching source image", "secondary"]]
        : [[c.depth, "Save depth video", ""], [c.src, "Save matching source", "secondary"]];
      for (const [f, label, cls] of saves) {
        if (!f) continue;
        const b = el("button", cls, label); b.dataset.label = label; b.onclick = () => DP.saveVideo(b, f.path, f.name);
        files.appendChild(b);
      }
      if (c.zip) { const a = el("a", "btn secondary", `Download 16-bit PNG frames (${(c.zip.size / 1048576).toFixed(0)} MB zip)`); a.href = c.zip.browser_download_url; files.appendChild(a); }
      else if (!c.png) files.appendChild(el("p", "muted", "No 16-bit PNG frames for this clip. Clips processed from now on include them."));
      $("st-status").hidden = true; $("st-main").hidden = false;
      setTab("watch");
    } catch (e) {
      if (clip !== c) return;
      $("st-status").className = "msg bad"; $("st-status").textContent = e.message;
    }
  }
  function closeClip() {
    open = false; clip = null;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    for (const v of [vD, vS, $("st-watch")]) { v.pause(); v.removeAttribute("src"); v.load(); }
    $("studio").hidden = true; document.querySelector("main").hidden = false;
  }
  $("st-close").onclick = closeClip;

  window.Studio = { open: openClip, close: closeClip, isOpen: () => open };
})();
