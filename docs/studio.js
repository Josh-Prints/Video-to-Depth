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
    style: "mesh", strength: 0.6, density: 240, pointSize: 3, invert: false, edge: 35,
    color: "video", bright: 1, bg: "dark",
    cutMode: "off", cut: 50,
    proj: "perspective", spin: false,
    speed: 1, loop: true,
  };
  let opt = { ...DEFAULTS, ...store.get("depthpass-view", {}) };
  const saveOpt = () => store.set("depthpass-view", opt);

  // ---------- state ----------
  let clip = null, tab = "watch", raf = 0, open = false;
  let points = [], selected = -1;
  const cam = { yaw: 0.5, pitch: 0.25, dist: 1.45, panX: 0, panY: 0 };
  const vD = $("st-vd"), vS = $("st-vs");
  let master = vS, aspect = 16 / 9, hasSrc = false;

  // ---------- GL ----------
  const glc = $("st-gl");
  let gl = null, prog = null, U = {}, texD = null, texC = null, deriv = false;
  let grid = { n: 0, verts: 0, tri: 0, line: 0, vb: null, tb: null, lb: null };
  let M = new Float32Array(16);

  const VS = `
attribute vec2 a; uniform sampler2D D; uniform mat4 M; uniform float S, inv, ps; uniform vec2 asp;
varying vec2 v; varying float vd;
void main(){ float d = texture2D(D, a).r; if (inv > 0.5) d = 1.0 - d; vd = d; v = a;
  gl_Position = M * vec4((a.x - 0.5) * asp.x, (0.5 - a.y) * asp.y, (d - 0.5) * S, 1.0); gl_PointSize = ps; }`;
  const FS = (d) => `${d ? "#extension GL_OES_standard_derivatives : enable\n" : ""}precision mediump float;
uniform sampler2D C; uniform int mode, cutMode; uniform float cut, edge, bright;
varying vec2 v; varying float vd;
vec3 heat(float t){ return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0); }
void main(){
  if (cutMode == 1 && vd < cut) discard;
  if (cutMode == 2 && vd > cut) discard;
  ${d ? "if (edge > 0.0 && fwidth(vd) > edge) discard;" : ""}
  vec3 c;
  if (mode == 0) c = texture2D(C, v).rgb;
  else if (mode == 1) c = vec3(vd);
  else if (mode == 2) c = heat(vd);
  else c = mix(texture2D(C, v).rgb, vec3(1.0), step(0.9, fract(vd * 20.0)) * 0.7);
  c *= bright;
  if (cutMode != 0 && abs(vd - cut) < 0.012) c = mix(c, vec3(0.2, 0.55, 1.0), 0.85);
  gl_FragColor = vec4(c, 1.0); }`;

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
    for (const n of ["D", "C", "M", "S", "inv", "ps", "asp", "mode", "cutMode", "cut", "edge", "bright"]) U[n] = gl.getUniformLocation(prog, n);
    const tex = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255])); return t; };
    texD = tex(0); texC = tex(1);
    gl.uniform1i(U.D, 0); gl.uniform1i(U.C, 1);
    gl.enable(gl.DEPTH_TEST);
    return true;
  }

  function buildGrid() {
    const n = opt.density;
    if (grid.n === n + ":" + aspect.toFixed(3)) return;
    const nx = aspect >= 1 ? n : Math.max(8, Math.round(n * aspect));
    const ny = aspect >= 1 ? Math.max(8, Math.round(n / aspect)) : n;
    const w = nx + 1, h = ny + 1;
    const v = new Float32Array(w * h * 2);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++) { v[i++] = x / nx; v[i++] = y / ny; }
    const t = new Uint16Array(nx * ny * 6), l = new Uint16Array((nx * h + ny * w) * 2);
    let ti = 0, li = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      t[ti++] = a; t[ti++] = c; t[ti++] = b; t[ti++] = b; t[ti++] = c; t[ti++] = d;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < nx; x++) { l[li++] = y * w + x; l[li++] = y * w + x + 1; }
    for (let y = 0; y < ny; y++) for (let x = 0; x < w; x++) { l[li++] = y * w + x; l[li++] = (y + 1) * w + x; }
    for (const k of ["vb", "tb", "lb"]) if (grid[k]) gl.deleteBuffer(grid[k]);
    grid = { n: n + ":" + aspect.toFixed(3), verts: w * h, tri: t.length, line: l.length,
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
    gl.uniform1i(U.mode, ["video", "depth", "heat", "bands"].indexOf(opt.color));
    gl.uniform1i(U.cutMode, ["off", "behind", "front", "outline"].indexOf(opt.cutMode));
    gl.uniform1f(U.cut, opt.cut / 100);
    gl.uniform1f(U.edge, opt.style === "mesh" && opt.edge > 0 ? 0.15 * Math.pow(0.03, opt.edge / 100) : 0);
    gl.uniform1f(U.bright, opt.bright);
    gl.bindBuffer(gl.ARRAY_BUFFER, grid.vb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (opt.style === "points") gl.drawArrays(gl.POINTS, 0, grid.verts);
    else if (opt.style === "wire") { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.lb); gl.drawElements(gl.LINES, grid.line, gl.UNSIGNED_SHORT, 0); }
    else { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grid.tb); gl.drawElements(gl.TRIANGLES, grid.tri, gl.UNSIGNED_SHORT, 0); }
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
    if (p.d == null) return null;
    const a = aspVec(), d = opt.invert ? 1 - p.d : p.d;
    const x = (p.u - 0.5) * a[0], y = (0.5 - p.v) * a[1], z = (d - 0.5) * opt.strength;
    const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 0) return null;
    return [(cx / cw * 0.5 + 0.5) * glc.clientWidth, (0.5 - cy / cw * 0.5) * glc.clientHeight];
  }

  // ---------- points tab ----------
  const p2 = $("st-2d"), p2ctx = p2.getContext("2d");
  function draw2D() {
    sizeCanvas(p2);
    const v = hasSrc ? vS : vD;
    if (v.readyState >= 2) p2ctx.drawImage(v, 0, 0, p2.width, p2.height);
  }
  function renderPointList() {
    const list = $("st-plist"); list.innerHTML = "";
    $("st-pempty").hidden = points.length > 0;
    $("st-pclear").hidden = points.length === 0;
    points.forEach((p, i) => {
      const row = el("div", "st-prow" + (i === selected ? " sel" : ""));
      const dot = el("span", "st-dot static", i + 1); dot.style.background = COLORS[i % COLORS.length];
      const mid = el("div", "st-pmid");
      const val = el("span", "st-pval"); val.dataset.i = i;
      const bar = el("div", "bar"); bar.appendChild(el("i")); bar.firstChild.dataset.i = i;
      mid.append(val, bar);
      const cut = el("button", "secondary small", "Cut here");
      cut.onclick = () => { if (p.d == null) return; opt.cut = Math.round(p.d * 100); if (opt.cutMode === "off") opt.cutMode = "behind"; saveOpt(); buildOptions(); setTab("3d"); };
      const rm = el("button", "secondary small", "Remove");
      rm.onclick = () => { points.splice(i, 1); selected = -1; savePoints(); renderPointList(); };
      const btns = el("div", "st-pbtns"); btns.append(cut, rm);
      row.append(dot, mid, btns);
      row.onclick = (e) => { if (e.target.tagName !== "BUTTON") { selected = i; renderPointList(); } };
      list.appendChild(row);
    });
    updatePointValues();
  }
  function updatePointValues() {
    document.querySelectorAll("#st-plist .st-pval").forEach((s) => {
      const p = points[+s.dataset.i]; if (!p) return;
      s.textContent = p.d == null ? "…" : `${Math.round(p.d * 100)}% near`;
    });
    document.querySelectorAll("#st-plist .bar > i").forEach((b) => {
      const p = points[+b.dataset.i]; if (p && p.d != null) b.style.width = `${p.d * 100}%`;
    });
  }
  const savePoints = () => clip && store.set("depthpass-pts:" + clip.name, points.map((p) => ({ u: p.u, v: p.v })));

  let tapStart = null;
  p2.addEventListener("pointerdown", (e) => { tapStart = [e.clientX, e.clientY]; });
  p2.addEventListener("pointerup", (e) => {
    if (!tapStart || Math.hypot(e.clientX - tapStart[0], e.clientY - tapStart[1]) > 8) return;
    const r = p2.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    const hit = points.findIndex((p) => Math.hypot((p.u - u) * r.width, (p.v - v) * r.height) < 22);
    if (hit >= 0) selected = hit;
    else if (points.length < 8) { points.push({ u, v, d: null }); selected = points.length - 1; savePoints(); }
    renderPointList();
  });
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
  const GROUPS = [
    ["Shape", [
      ["seg", "style", "Draw as", [["mesh", "Surface"], ["points", "Dots"], ["wire", "Wireframe"]]],
      ["range", "strength", "Depth strength", 0, 2, 0.05],
      ["seg", "density", "Detail", [[96, "Low"], [160, "Medium"], [240, "High"], [320, "Max"]]],
      ["range", "pointSize", "Dot size", 1, 8, 0.5],
      ["range", "edge", "Hide stretched edges", 0, 100, 5],
      ["toggle", "invert", "Flip near and far"],
    ]],
    ["Colour", [
      ["seg", "color", "Colour from", [["video", "Video"], ["depth", "Depth"], ["heat", "Heat map"], ["bands", "Contours"]]],
      ["range", "bright", "Brightness", 0.5, 1.5, 0.05],
      ["seg", "bg", "Background", [["dark", "Dark"], ["grey", "Grey"], ["light", "Light"]]],
    ]],
    ["Cut plane", [
      ["note", "Slices the scene at one depth, like a wall. Tip: map a point on the wall, then tap Cut here."],
      ["seg", "cutMode", "Mode", [["off", "Off"], ["behind", "Hide behind"], ["front", "Hide in front"], ["outline", "Outline only"]]],
      ["range", "cut", "Position (far to near)", 0, 100, 1],
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
    if (key === "speed") vD.playbackRate = vS.playbackRate = opt.speed;
    if (key === "loop") vD.loop = vS.loop = opt.loop;
  }
  function buildOptions() {
    const root = $("st-options"); root.innerHTML = "";
    for (const [title, items] of GROUPS) {
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
        } else if (kind === "toggle") {
          const lab = el("label", "st-toggle"); const c = el("input"); c.type = "checkbox"; c.checked = !!opt[key]; c.id = "opt-" + key;
          c.onchange = () => { opt[key] = c.checked; applyOpt(key); };
          lab.append(c, el("span", null, label)); field.appendChild(lab);
        }
        body.appendChild(field);
      }
      det.appendChild(body); root.appendChild(det);
    }
    const reset = el("button", "secondary", "Reset all options");
    reset.onclick = () => { opt = { ...DEFAULTS }; applyOpt("speed"); applyOpt("loop"); setView("Angle"); };
    root.appendChild(reset);
  }

  // ---------- loop ----------
  function frame() {
    raf = 0;
    if (!open) return;
    if (tab === "3d" || tab === "points") {
      if (hasSrc && Math.abs(vD.currentTime - vS.currentTime) > 0.07) vD.currentTime = vS.currentTime;
      sampleDepths();
      if (tab === "3d") { draw3D(); placeMarkers($("st-m3d"), project3D); }
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
    $("st-transport").hidden = !(t === "3d" || t === "points");
    const w = $("st-watch");
    if (t !== "watch") w.pause();
    if (t !== "3d" && t !== "points") setPlaying(false);
    if (t === "3d") {
      try { if (!initGL()) throw new Error("no webgl"); $("st-glmsg").hidden = true; }
      catch (e) { $("st-glmsg").hidden = false; $("st-glmsg").textContent = "This browser couldn't start 3D graphics."; }
      buildOptions();
    }
    if (t === "points") renderPointList();
    if ((t === "3d" || t === "points") && master.readyState < 2) seek(0.001);
    if (!raf) raf = requestAnimationFrame(frame);
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
    points = store.get("depthpass-pts:" + c.name, []).map((p) => ({ u: p.u, v: p.v, d: null })); selected = -1;
    try {
      const [fd, fs] = await Promise.all([DP.getFile(c.depth.path, c.depth.name), hasSrc ? DP.getFile(c.src.path, c.src.name) : null]);
      if (clip !== c) return;
      const ud = DP.urlFor(c.depth.path, fd), us = fs ? DP.urlFor(c.src.path, fs) : null;
      const ready = (v, u) => new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("This browser couldn't play the video.")); v.src = u; v.load(); });
      await Promise.all([ready(vD, ud), us ? ready(vS, us) : null]);
      if (clip !== c) return;
      aspect = (vD.videoWidth || 16) / (vD.videoHeight || 9);
      samp.height = Math.round(samp.width / aspect);
      for (const id of ["st-stage3d", "st-stage2d"]) $(id).style.aspectRatio = `${vD.videoWidth} / ${vD.videoHeight}`;
      vD.loop = vS.loop = opt.loop;
      // Watch tab
      const w = $("st-watch"); let kind = "depth";
      const showWatch = () => { w.src = kind === "depth" ? ud : us; document.querySelectorAll("#st-wseg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === kind))); };
      $("st-wseg").hidden = !us;
      document.querySelectorAll("#st-wseg button").forEach((b) => { b.onclick = () => { kind = b.dataset.kind; showWatch(); }; });
      showWatch();
      // Files tab
      const files = $("st-files"); files.innerHTML = "";
      for (const [f, label, cls] of [[c.depth, "Save depth video", ""], [c.src, "Save matching source", "secondary"]]) {
        if (!f) continue;
        const b = el("button", cls, label); b.dataset.label = label; b.onclick = () => DP.saveVideo(b, f.path, f.name);
        files.appendChild(b);
      }
      if (c.zip) { const a = el("a", "btn secondary", `Download 16-bit PNG frames (${(c.zip.size / 1048576).toFixed(0)} MB zip)`); a.href = c.zip.browser_download_url; files.appendChild(a); }
      else files.appendChild(el("p", "muted", "No 16-bit PNG frames for this clip. Clips processed from now on include them."));
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
