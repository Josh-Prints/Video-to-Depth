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
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"}

BACKEND = (os.environ.get("BACKEND") or "local").lower()
MAX_RES = int(os.environ.get("MAX_RES") or 1280)
MAX_FPS = int(os.environ.get("MAX_FPS") or 30)
ENCODER = os.environ.get("ENCODER") or "vits"           # vits (fast) or vitl (better, much slower on CPU)
PNG16 = (os.environ.get("PNG16") or "true").lower() == "true"
FORCE = (os.environ.get("FORCE") or "false").lower() == "true"
ONLY = (os.environ.get("ONLY_FILE") or "").strip()
VDA_DIR = os.environ.get("VDA_DIR") or "vda"             # clone of DepthAnything/Video-Depth-Anything
ARTIFACT_DIR = "artifact"


def ffmpeg_bin():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


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
    from utils.dc_utils import read_video_frames, save_video

    if _model is None:
        cfg = {"vits": dict(features=64, out_channels=[48, 96, 192, 384]),
               "vitb": dict(features=128, out_channels=[96, 192, 384, 768]),
               "vitl": dict(features=256, out_channels=[256, 512, 1024, 1024])}[ENCODER]
        _model = VideoDepthAnything(encoder=ENCODER, **cfg)
        ckpt = os.path.join(VDA_DIR, "checkpoints", f"video_depth_anything_{ENCODER}.pth")
        _model.load_state_dict(torch.load(ckpt, map_location="cpu"), strict=True)
        _model = _model.to("cpu").eval()
        torch.set_num_threads(os.cpu_count() or 2)

    frames, fps = read_video_frames(clean, -1, -1, MAX_RES)
    print(f"{len(frames)} frames at {frames.shape[2]}x{frames.shape[1]}, {fps:.2f} fps. Running {ENCODER} on CPU...")
    t = time.time()
    with torch.inference_mode():
        depths, fps = _model.infer_video_depth(frames, fps, input_size=518, device="cpu", fp32=True)
    print(f"Inference took {time.time() - t:.0f}s")

    save_video(frames, f"output/{name}_src.mp4", fps=fps)
    save_video(depths, f"output/{name}_depth.mp4", fps=fps, is_depths=True, grayscale=True)

    if PNG16:
        d = np.asarray(depths, dtype=np.float32)
        lo, hi = float(d.min()), float(d.max())
        out = os.path.join(ARTIFACT_DIR, f"{name}_depth16")
        os.makedirs(out, exist_ok=True)
        for i, f in enumerate(d):
            cv2.imwrite(f"{out}/{name}_{i:05d}.png", ((f - lo) / (hi - lo + 1e-12) * 65535).astype(np.uint16))
        print(f"Wrote {len(d)} 16-bit PNGs to {out}")


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
    files = sorted(f for f in glob.glob("input/*") if os.path.isfile(f) and not f.endswith(".gitkeep"))
    if ONLY:
        files = [f for f in files if os.path.basename(f) == os.path.basename(ONLY)]
    vids = []
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext in AUDIO_EXT:
            print(f"Skipping {f}: audio file, no picture to get depth from.")
        elif ext in VIDEO_EXT:
            vids.append(f)
        else:
            print(f"Skipping {f}: unknown extension.")
    if not vids:
        sys.exit("No video found in input/")

    os.makedirs("output", exist_ok=True)
    run = run_space if BACKEND == "space" else run_local
    failed = []
    for src in vids:
        name = os.path.splitext(os.path.basename(src))[0]
        if os.path.exists(f"output/{name}_depth.mp4") and not FORCE:
            print(f"Skip {src}: output/{name}_depth.mp4 exists (run manually with force to redo)")
            continue
        print(f"\n=== {src} ({BACKEND}) ===")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                clean = os.path.join(tmp, f"{name}.mp4")
                normalize(src, clean)
                run(clean, name)
            print(f"Saved output/{name}_depth.mp4 and output/{name}_src.mp4")
        except Exception as e:
            print(f"FAILED {src}: {e}")
            failed.append(src)
    if failed:
        sys.exit(f"Failed: {failed}")


if __name__ == "__main__":
    main()
