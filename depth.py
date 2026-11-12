"""Turn every new video in input/ into a depth video with Video Depth Anything.

Backends (env BACKEND):
  local  (default) - runs the official model on the GitHub runner's CPU. Weights come
                     from Hugging Face. No quota, no token. Slower, but it finishes.
  space            - calls the hosted HF Space (ZeroGPU). That Space requests 360s of GPU
                     per call, which is more than a free account's whole daily quota, so
                     in practice this only works with an HF PRO token in HF_TOKEN.

Outputs in output/:
  <name>_depth.mp4   grayscale depth, white = near, black = far, one scale for the whole clip
  <name>_src.mp4     the exact frames depth was computed on (same size/fps/frame count)
  (local only, saved as a workflow artifact, not committed)
  <name>_depth16/    16-bit PNG sequence, same normalization, for precise displacement
"""
import os, sys, glob, shutil, subprocess, tempfile, time

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".mts", ".m2ts", ".ts",
             ".wmv", ".flv", ".mpg", ".mpeg", ".hevc", ".gif"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff"}
IS_PHOTO = False                      # set per file in main()
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"}

BACKEND = (os.environ.get("BACKEND") or "local").lower()
MAX_RES = int(os.environ.get("MAX_RES") or 1280)
MAX_FPS = int(os.environ.get("MAX_FPS") or 30)
ENCODER = os.environ.get("ENCODER") or "vits"           # vits (fast) or vitl (better, much slower on CPU)
# Models tried in order on Kaggle's GPU. Large (vitl) needs ~20 GB without xformers and Kaggle's free
# GPUs have ~15 GB, so the default starts at Base. Each failure moves on to the next.
KAGGLE_ENCODER = os.environ.get("KAGGLE_ENCODER") or "vitb,vits"
KAGGLE_TIMEOUT = int(os.environ.get("KAGGLE_TIMEOUT") or 3600)
VDA_SHA = os.environ.get("VDA_SHA") or "4f5ae23172ba60fd7bc11ef671cca678842c7072"
PNG16 = (os.environ.get("PNG16") or "true").lower() == "true"
FORCE = (os.environ.get("FORCE") or "false").lower() == "true"
ONLY = [os.path.basename(x.strip()) for x in (os.environ.get("ONLY_FILE") or "").split(",") if x.strip()]
EVENT = os.environ.get("GITHUB_EVENT_NAME") or ""
VDA_DIR = os.environ.get("VDA_DIR") or "vda"             # clone of DepthAnything/Video-Depth-Anything
ARTIFACT_DIR = "artifact"


class Progress:
    """Publishes runs/<run id>.json on the `status` branch so the upload page can show a live bar.
    Never raises: progress reporting must not be able to break a job."""
    def __init__(self):
        self.token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        self.repo = os.environ.get("GITHUB_REPOSITORY")
        self.state = {"run_id": os.environ.get("GITHUB_RUN_ID"), "started": int(time.time())}
        self.path = f"/contents/runs/{self.state['run_id']}.json"
        self.sha = None
        self.ready = False

    def _api(self, method, path, body=None):
        import json, urllib.request
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "depth-bot"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"null")

    def _setup(self):
        import urllib.error
        try:
            self._api("GET", "/git/ref/heads/status")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            self._api("POST", "/git/refs", {"ref": "refs/heads/status", "sha": os.environ["GITHUB_SHA"]})
        try:
            self.sha = self._api("GET", self.path + "?ref=status")["sha"]
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
        self.ready = True

    def update(self, **kw):
        import base64, json
        self.state.update(kw, updated=int(time.time()))
        if not (self.token and self.repo):
            return
        try:
            if not self.ready:
                self._setup()
            body = {"message": "progress", "branch": "status",
                    "content": base64.b64encode(json.dumps(self.state).encode()).decode()}
            if self.sha:
                body["sha"] = self.sha
            self.sha = self._api("PUT", self.path, body)["content"]["sha"]
        except Exception as e:
            self.ready = False
            print(f"(progress update skipped: {e})")


PROGRESS = Progress()


def publish_zip(zip_path, name):
    """Attach a zip of the 16-bit PNG sequence to a GitHub release so the page can link to it."""
    import re
    if not (shutil.which("gh") and os.environ.get("GH_TOKEN")):
        return
    try:
        tag = "png-" + re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
        made = subprocess.run(["gh", "release", "create", tag, zip_path, "--title", f"{name} 16-bit depth PNGs",
                               "--notes", "16-bit PNG depth sequence. Same normalization as the depth video."],
                              capture_output=True, text=True)
        if made.returncode != 0:  # release already exists (forced redo): replace the file
            subprocess.run(["gh", "release", "upload", tag, zip_path, "--clobber"], check=True)
        print(f"Published {os.path.basename(zip_path)} to release {tag}")
    except Exception as e:
        print(f"(PNG zip not published: {e})")


def publish_pngs(folder, name):
    publish_zip(shutil.make_archive(os.path.join(ARTIFACT_DIR, f"{name}_depth16"), "zip", folder), name)


def ffmpeg_bin():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def photo_to_clip(src, dst):
    """Turn a photo into a one-frame H.264 clip the model can read. Pillow applies the phone's
    rotation flag and reads HEIC; ffmpeg alone gets both wrong on some builds."""
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    png = dst + ".png"
    ImageOps.exif_transpose(Image.open(src)).convert("RGB").save(png)
    scale = (f"scale='if(gt(iw,ih),min({MAX_RES},iw),-2)':'if(gt(iw,ih),-2,min({MAX_RES},ih))'")
    cmd = [ffmpeg_bin(), "-y", "-v", "error", "-i", png, "-frames:v", "1", "-r", "30",
           "-vf", f"{scale},pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "10", dst]
    if subprocess.run(cmd).returncode != 0:
        raise RuntimeError(f"Could not read the photo {src}.")


def normalize(src, dst):
    """Re-encode to plain 8-bit H.264 MP4: bakes in phone rotation, drops HEVC/HDR/audio,
    scales the long side to MAX_RES, caps fps. Phone .MOV files (HEVC, Dolby Vision,
    rotation flags) otherwise decode wrong or not at all."""
    scale = (f"scale='if(gt(iw,ih),min({MAX_RES},iw),-2)':'if(gt(iw,ih),-2,min({MAX_RES},ih))'")
    for fps in (f"fps='min({MAX_FPS},source_fps)'", f"fps={MAX_FPS}"):  # 2nd = old ffmpeg fallback
        cmd = [ffmpeg_bin(), "-y", "-v", "error", "-i", src, "-an", "-vf", f"{scale},{fps},format=yuv420p",
               "-c:v", "libx264", "-crf", "16", "-preset", "medium", dst]
        if subprocess.run(cmd).returncode == 0:
            return
    raise RuntimeError(f"ffmpeg could not read {src}. Is it actually a video?")


# ---------------- local backend ----------------
_model = None

def run_local(clean, name):
    global _model
    import numpy as np, torch, cv2
    sys.path.insert(0, os.path.abspath(VDA_DIR))
    from video_depth_anything.video_depth import VideoDepthAnything
    from utils.dc_utils import read_video_frames, save_video  # save_video only for RGB (its depth path needs old matplotlib)

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    if _model is None:
        cfg = {"vits": dict(features=64, out_channels=[48, 96, 192, 384]),
               "vitb": dict(features=128, out_channels=[96, 192, 384, 768]),
               "vitl": dict(features=256, out_channels=[256, 512, 1024, 1024])}[ENCODER]
        _model = VideoDepthAnything(encoder=ENCODER, **cfg)
        ckpt = os.path.join(VDA_DIR, "checkpoints", f"video_depth_anything_{ENCODER}.pth")
        _model.load_state_dict(torch.load(ckpt, map_location="cpu"), strict=True)
        _model = _model.to(DEVICE).eval()
        torch.set_num_threads(os.cpu_count() or 2)

    import video_depth_anything.video_depth as vd
    def windows(it, *a, **k):          # replaces tqdm in the upstream loop: one step per 32-frame window
        items = list(it)
        PROGRESS.update(stage="depth", done=0, total=len(items), depth_started=int(time.time()))
        for i, x in enumerate(items):
            yield x
            print(f"window {i + 1}/{len(items)} done", flush=True)
            PROGRESS.update(stage="depth", done=i + 1, total=len(items))
    vd.tqdm = windows

    frames, fps = read_video_frames(clean, -1, -1, MAX_RES)
    print(f"{len(frames)} frames at {frames.shape[2]}x{frames.shape[1]}, {fps:.2f} fps. Running {ENCODER} on {DEVICE}...")
    t = time.time()
    with torch.inference_mode():
        depths, fps = _model.infer_video_depth(frames, fps, input_size=518, device=DEVICE, fp32=(DEVICE == "cpu"))
    print(f"Inference took {time.time() - t:.0f}s")

    PROGRESS.update(stage="saving")
    import imageio
    d = np.asarray(depths, dtype=np.float32)
    lo, hi = float(d.min()), float(d.max())          # one scale for the whole clip
    if IS_PHOTO:
        # Full-quality stills for editing, plus a one-second clip so the page's viewer works unchanged.
        cv2.imwrite(f"output/{name}_depth.png", ((d[0] - lo) / (hi - lo + 1e-12) * 65535).astype(np.uint16))
        cv2.imwrite(f"output/{name}_src.png", cv2.cvtColor(np.asarray(frames[0]), cv2.COLOR_RGB2BGR))
        d = np.repeat(d[:1], 30, axis=0)
        frames = np.repeat(np.asarray(frames)[:1], 30, axis=0)
        fps = 30
    # Depth first, src last: a half-finished run never leaves a src without its depth.
    w = imageio.get_writer(f"output/{name}_depth.mp4", fps=fps, macro_block_size=1,
                           codec="libx264", ffmpeg_params=["-crf", "12"])
    for f in d:
        g = ((f - lo) / (hi - lo + 1e-12) * 255).round().astype(np.uint8)
        w.append_data(np.stack([g, g, g], axis=-1))
    w.close()
    save_video(frames, f"output/{name}_src.mp4", fps=fps)

    if PNG16 and not IS_PHOTO:
        out = os.path.join(ARTIFACT_DIR, f"{name}_depth16")
        os.makedirs(out, exist_ok=True)
        for i, f in enumerate(d):
            cv2.imwrite(f"{out}/{name}_{i:05d}.png", ((f - lo) / (hi - lo + 1e-12) * 65535).astype(np.uint16))
        print(f"Wrote {len(d)} 16-bit PNGs to {out}")
        publish_pngs(out, name)


# ---------------- kaggle backend ----------------
# The runner starts a private Kaggle script with a free GPU. That script clones this (public) repo at the
# same commit, runs this same file with the Large model, and leaves the results as its output, which the
# runner downloads. No GitHub credentials go to Kaggle.
KERNEL = '''import glob, os, shutil, subprocess, sys
def sh(c):
    print("+", c, flush=True); subprocess.run(c, shell=True, check=True)
os.makedirs("/tmp/w", exist_ok=True); os.chdir("/tmp/w")
sh("pip install -q easydict einops imageio imageio-ffmpeg pillow-heif")
sh("git clone -q https://github.com/{repo} app && git -C app checkout -q {sha}")
os.chdir("app")
sh("git init -q vda && git -C vda fetch -q --depth 1 https://github.com/DepthAnything/Video-Depth-Anything {vda_sha} && git -C vda checkout -q FETCH_HEAD")
for f in glob.glob("output/*"):
    if not f.endswith(".gitkeep"): os.remove(f)
SIZE = dict(vitl="Large", vitb="Base", vits="Small")
ok = False
for enc in {encs!r}.split(","):
    sh("mkdir -p vda/checkpoints && curl -fL --retry 3 -o vda/checkpoints/video_depth_anything_%s.pth "
       "https://huggingface.co/depth-anything/Video-Depth-Anything-%s/resolve/main/video_depth_anything_%s.pth" % (enc, SIZE[enc], enc))
    env = dict(os.environ, BACKEND="local", ENCODER=enc, ONLY_FILE={file!r}, FORCE="true",
               MAX_RES="{max_res}", MAX_FPS="{max_fps}", GITHUB_EVENT_NAME="", GH_TOKEN="", GITHUB_TOKEN="",
               PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
    r = subprocess.run([sys.executable, "depth.py"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(r.stdout[-3000:], flush=True)
    if r.returncode == 0:
        open("/kaggle/working/model.txt", "w").write(enc); ok = True; break
    why = [l for l in r.stdout.splitlines() if "Error" in l or "FAILED" in l][-2:]
    open("/kaggle/working/attempts.txt", "a").write("%s: %s" % (enc, " | ".join(why)[:500]) + chr(10))
if not ok: raise SystemExit("every model failed")
out = "/kaggle/working"
for f in glob.glob("output/*"):
    if not f.endswith(".gitkeep"): shutil.copy(f, out)
for d in glob.glob("artifact/*_depth16"):
    shutil.make_archive(os.path.join(out, os.path.basename(d)), "zip", d)
print("DONE", os.listdir(out))
'''


def kaggle(*args, check=True):
    env = dict(os.environ)
    key = env.get("KAGGLE_KEY", "")
    if key.startswith("KGAT_"):                 # new-style Kaggle token
        env["KAGGLE_API_TOKEN"] = key; env.pop("KAGGLE_KEY", None)
    r = subprocess.run(["kaggle", *args], capture_output=True, text=True, env=env)
    out = (r.stdout + r.stderr).strip()
    if check and r.returncode != 0:
        raise RuntimeError(f"kaggle {args[0]} {args[1]} failed: {out[-400:]}")
    return out


def kaggle_log(ref, tmp):
    """Last lines of a Kaggle job's own log, so a failure there is explained here."""
    import glob, json
    try:
        d = os.path.join(tmp, "faillog")
        kaggle("kernels", "output", ref, "-p", d, check=False)
        lines = []
        for f in glob.glob(os.path.join(d, "*.log")):
            raw = open(f, errors="replace").read()
            try:
                lines += [str(e.get("data", "")).rstrip() for e in json.loads(raw)]
            except Exception:
                lines += raw.splitlines()
        return "\n".join(l for l in lines if l.strip())[-1500:] or "(no log returned)"
    except Exception as e:
        return f"(could not fetch the log: {e})"


def run_kaggle(src, name):
    import json, re
    user = os.environ.get("KAGGLE_USERNAME")
    if not (user and os.environ.get("KAGGLE_KEY") and shutil.which("kaggle")):
        raise RuntimeError("Kaggle is not set up (KAGGLE_USERNAME / KAGGLE_KEY secrets)")
    slug = f"depth-pass-{os.environ.get('GITHUB_RUN_ID') or int(time.time())}-{abs(hash(name)) % 10000}"
    ref = f"{user}/{slug}"
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "run.py"), "w") as f:
            f.write(KERNEL.format(repo=os.environ["GITHUB_REPOSITORY"], sha=os.environ["GITHUB_SHA"], vda_sha=VDA_SHA,
                                  encs=KAGGLE_ENCODER,
                                  file=os.path.basename(src), max_res=MAX_RES, max_fps=MAX_FPS))
        with open(os.path.join(tmp, "kernel-metadata.json"), "w") as f:
            json.dump({"id": ref, "title": slug, "code_file": "run.py", "language": "python", "kernel_type": "script",
                       "is_private": True, "enable_gpu": True, "enable_internet": True,
                       "dataset_sources": [], "competition_sources": [], "kernel_sources": []}, f)
        pushed = kaggle("kernels", "push", "-p", tmp)
        if "successfully pushed" not in pushed.lower():
            raise RuntimeError(f"Kaggle refused the job: {pushed[-400:]}")
        print(f"Started Kaggle job {ref}")
        PROGRESS.update(stage="gpu", gpu_started=int(time.time()))
        try:
            deadline = time.time() + KAGGLE_TIMEOUT
            while True:
                time.sleep(20)
                st = kaggle("kernels", "status", ref, check=False).lower()
                if "complete" in st:
                    break
                if re.search(r"error|cancel|fail", st.split("status")[-1]):
                    raise RuntimeError(f"Kaggle job failed. Its log ended with:\n{kaggle_log(ref, tmp)}")
                if time.time() > deadline:
                    raise RuntimeError("Kaggle job timed out")
            out = os.path.join(tmp, "out")
            kaggle("kernels", "output", ref, "-p", out)
            got = [f for f in os.listdir(out) if f.startswith(name + "_")]
            try: used = open(os.path.join(out, "model.txt")).read().strip()
            except OSError: used = "?"
            print(f"Kaggle used model: {used}")
            try: tried = open(os.path.join(out, "attempts.txt")).read().strip()
            except OSError: tried = ""
            if tried: print(f"Models that failed on Kaggle first:\n{tried}")
            PROGRESS.update(kaggle_model=used, kaggle_attempts=tried[-1200:])
            if f"{name}_depth.mp4" not in got:
                raise RuntimeError(f"Kaggle finished but returned no depth video (files: {os.listdir(out)})")
            PROGRESS.update(stage="saving")
            for f in got:
                if f.endswith("_depth16.zip"):
                    os.makedirs(ARTIFACT_DIR, exist_ok=True)
                    publish_zip(shutil.move(os.path.join(out, f), os.path.join(ARTIFACT_DIR, f)), name)
                else:
                    shutil.move(os.path.join(out, f), os.path.join("output", f))
        finally:
            kaggle("kernels", "delete", ref, "-y", check=False)      # keep the Kaggle account tidy; fine if unsupported


# ---------------- space backend ----------------
_client = None

def run_space(clean, name):
    global _client
    from gradio_client import Client, handle_file
    if _client is None:
        token = os.environ.get("HF_TOKEN") or None
        if not token:
            print("WARNING: no HF_TOKEN. Anonymous calls are refused by this Space (it wants 360s of GPU).")
        try:
            _client = Client("depth-anything/Video-Depth-Anything", hf_token=token, verbose=False)
        except TypeError:
            _client = Client("depth-anything/Video-Depth-Anything", token=token, verbose=False)
    for attempt in range(1, 4):
        try:
            res = _client.predict({"video": handle_file(clean)}, -1, -1, MAX_RES, True,
                                  api_name="/infer_video_depth")
            break
        except Exception as e:
            msg = str(e)
            print(f"Attempt {attempt} failed: {msg}")
            if any(k in msg.lower() for k in ("quota", "maximum allowed", "pro")):
                raise RuntimeError("ZeroGPU refused the job (quota/duration). Use backend=local.") from e
            if attempt == 3:
                raise
            time.sleep(30 * attempt)
    src_out, depth_out = ((r.get("video") if isinstance(r, dict) else r) for r in res)
    shutil.copy(depth_out, f"output/{name}_depth.mp4")
    shutil.copy(src_out, f"output/{name}_src.mp4")


def main():
    global IS_PHOTO
    files = sorted(f for f in glob.glob("input/*") if os.path.isfile(f) and not f.endswith(".gitkeep"))
    if ONLY:
        files = [f for f in files if os.path.basename(f) in ONLY]
    elif EVENT == "push":      # each upload's run handles only the files from its own push
        print("This push added no video to input/. Nothing to do.")
        return
    vids = []
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext in AUDIO_EXT:
            print(f"Skipping {f}: audio file, no picture to get depth from.")
        elif ext in VIDEO_EXT or ext in IMAGE_EXT:
            vids.append(f)
        else:
            print(f"Skipping {f}: unknown extension.")
    if not vids:
        print("No photo or video found in input/. Nothing to do.")
        return

    os.makedirs("output", exist_ok=True)
    run = run_space if BACKEND == "space" else run_local
    global ENCODER
    failed = []
    todo = []
    for src in vids:
        name = os.path.splitext(os.path.basename(src))[0]
        if os.path.exists(f"output/{name}_depth.mp4") and not FORCE:
            print(f"Skip {src}: output/{name}_depth.mp4 exists (run manually with force to redo)")
        else:
            todo.append((src, name))
    for n, (src, name) in enumerate(todo):
        print(f"\n=== {src} ({BACKEND}) ===")
        PROGRESS.update(stage="converting", file=os.path.basename(src), file_index=n + 1,
                        file_count=len(todo), done=0, total=0, error=None)
        try:
            if BACKEND == "kaggle":
                try:
                    run_kaggle(src, name)
                    print(f"Saved output/{name}_depth.mp4 (Kaggle GPU)")
                    continue
                except Exception as e:
                    print(f"Kaggle didn't work ({e}). Falling back to this machine's CPU.")
                    PROGRESS.update(stage="converting", note="GPU unavailable, using the slower machine",
                                    kaggle_error=str(e)[-1500:])
            with tempfile.TemporaryDirectory() as tmp:
                clean = os.path.join(tmp, f"{name}.mp4")
                IS_PHOTO = os.path.splitext(src)[1].lower() in IMAGE_EXT
                (photo_to_clip if IS_PHOTO else normalize)(src, clean)
                run(clean, name)
            print(f"Saved output/{name}_depth.mp4 and output/{name}_src.mp4")
        except Exception as e:
            print(f"FAILED {src}: {type(e).__name__}: {str(e)[:600]}")
            failed.append(src)
            PROGRESS.update(stage="failed", error=str(e)[:300])
    if failed:
        sys.exit(f"Failed: {failed}")
    if todo:
        PROGRESS.update(stage="done")


if __name__ == "__main__":
    main()
