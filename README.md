# Video-to-Depth

Upload a photo or video to `input/`. GitHub Actions runs [Video Depth Anything](https://github.com/DepthAnything/Video-Depth-Anything) on it, using the official weights from Hugging Face, and commits the depth video to `output/`. Nothing runs on your phone, so you can close the tab.

## Easiest: the upload page
**https://josh-prints.github.io/Video-to-Depth/** (once GitHub Pages is on: Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, folder `/docs`).

Everything happens on that page: log in, upload a clip, watch a live progress bar with a time estimate, preview the depth and source videos, save them to your phone, and download the 16-bit PNG frames as a zip. You can close it while a job runs.

Tap a clip to open it. It has four tabs:
- **Watch**: the depth and source videos.
- **3D**: the depth video as a 3D surface you can rotate and zoom, with options for shape, colour, a cut plane, camera and playback.
- **Points**: tap the source video to drop up to 8 points and read how near each spot is on the current frame. "Cut here" puts the 3D cut plane at that point's depth.
- **Files**: save the videos and download the 16-bit PNG frames.

**3-point cut plane:** in Points, tap 3 spots on the wall and tap "Make a cut plane". Drag a point to move it, or tap Adjust for left-right, up-down and depth sliders; the plane follows points 1–3 as they change. The Points view has a Show the cut toggle with the cut options and a choice of checkerboard, dimmed or black for removed parts. The depths are locked at that frame, and the 3D tab's Cut plane can hide what's behind or in front of the plane, outline it, or nudge it.

**Export the slice** (Files tab): the source video with everything the cut hides made see-through, as transparent PNG frames (zip), a transparent WebM (where the browser can record transparency, e.g. Chrome), or a black-and-white mask video (white = kept) for use as a track matte. Optional half size.

**Coloured depth:** Watch → Coloured runs the depth video through the distance colour settings (palettes, custom colours, steps, curve, range, contour lines, highlight) and can save the result as a video.

Login: on first visit you paste a **fine-grained token** (this repo only, **Contents: Read and write**, **Actions: Read-only**) and choose a passcode. The token is stored encrypted with that passcode in the browser. After that you log in with the passcode; a login lasts 8 hours or until you close the tab.

**Other devices.** In the page, open "Use on my other devices" and set a password of 10+ characters. Then any phone or computer can log in with your GitHub username and that password, with no token. The token is encrypted with the password (PBKDF2-SHA256, 600k rounds, AES-GCM) and stored at `accounts/<user>.json` on the `status` branch. Anyone who can read the repo can download that file, so the password is the only protection. Use a long one you don't use anywhere else.

The login locks the page, not the repo. While the repo is public, the files in `input/` and `output/` are still visible on github.com.

Each person sees only their own clips, jobs and progress. Uploads are named `<github user>__<time>_<name>`, and jobs are matched to whoever uploaded them. This is a filter in the page, not access control: anyone who can read the repo can still see every file on github.com.

Several uploads are processed at the same time, each in its own run.

Progress is published by each run to `runs/<run id>.json` on the `status` branch. PNG zips are attached to releases tagged `png-<name>`.

## Or upload through github.com
1. On github.com, open this repo, tap **Add file → Upload files**, pick your clip, and tap **Commit changes**.
2. Open the **Actions** tab. A "Depth video" run starts automatically.
3. When it goes green, open `output/`:
   - `<name>_depth.mp4`: grayscale depth. **White = near, black = far.** One brightness scale covers the whole clip, so the wall and the hand are comparable across frames.
   - `<name>_src.mp4`: the exact frames the depth was made from, with the same size, fps and frame count. Line this up against the depth, not your original.
4. For a **16-bit PNG depth sequence** (smoother displacement than 8-bit video), open the run's page and download the `depth-output` artifact at the bottom.

Accepted: `.mov .mp4 .m4v .mkv .webm .avi .3gp .mts .m2ts .ts .wmv .flv .mpg .mpeg .hevc .gif`. Audio files (`.mp3`, `.wav` etc.) are skipped, since they have no picture.

Every input gets re-encoded first: phone rotation is baked in, HEVC is converted to H.264, audio is dropped, the long side is capped at 1280 and the frame rate at 30. Clips that already have output are skipped.

## Faster and better: Kaggle's free GPU
Add two repository secrets (Settings → Secrets and variables → Actions): `KAGGLE_USERNAME` and `KAGGLE_KEY` (a Kaggle API token; the account must be phone-verified so GPU and internet are allowed). Uploads then run on Kaggle's two GPUs. The upload page's **Quality** control picks the model (Small, Base, Large) and the working resolution, shows a time estimate from the clip's length, and sends the choice in the upload's commit message as `[model=vitl size=518]`. Default: Large at 518. The encoder runs a few frames at a time and the depth head runs on the second GPU, which is what lets Large at 518 fit. A setting that fails steps down to smaller ones.

**Photos** use Depth Anything V2 instead (an image model): the largest model and working size that fit, with the depth PNG saved at the photo's own resolution (long side capped at 4096).

Measured on Kaggle for a 9.5 s clip: Small 61 s, Base 110 s, Large 243 s of GPU time, plus about 4 minutes of fixed overhead. A photo takes about 3 minutes.

If Kaggle refuses or fails, the job falls back to the runner's CPU with the Small model, so you still get a result. Without the secrets nothing changes.

## Limits
- **GitHub web upload max is 25 MB per file.** A 9 s clip at 1080p30 fits. 4K or 60 fps probably won't, so film at 1080p30.
- Turn **HDR off** in the iPhone camera settings. HDR footage gets converted without tone-mapping and comes out washed out. Depth still works, but it's worse input.
- Runs on the runner's CPU, so expect several minutes for a short clip. `vitl` (manual run option) is higher quality and much slower.

## Manual run / options
In **Actions → Depth video → Run workflow** you can set:
- `file`: process only this file
- `force`: redo existing output
- `encoder`: `vits` (default) or `vitl`
- `max_fps`, `max_res`
- `backend`: `local` (default) or `space`

`space` calls the hosted HF Space `depth-anything/Video-Depth-Anything`. That Space requests 360 s of ZeroGPU per call, and free accounts only get 5 min a day, so it's refused unless the repo secret `HF_TOKEN` belongs to an **HF PRO** account. `local` needs no token.

## Version
The site shows `Depth Pass v<APP_VERSION>` at the bottom, plus the commit Pages is serving. Bump `APP_VERSION` in `docs/index.html` with each change to the site.

## Cuts and merging
- **Cuts:** up to 4 at once (3D → Cuts, or the Points cut preview). Each is one distance or a plane through any 3 points, set to hide behind, hide in front, or outline, with a nudge. A pixel is hidden if any cut hides it. In 3D, cuts test the surface's own depth, so they're straight lines across it.
- **Merging two clips:** upload the background (for example the empty wall) and the foreground (the hand) as separate clips. In the foreground clip, Watch → Merged → pick the background. The foreground shows only where it's nearer than the background. Auto-match fits the foreground's depth scale to the background's; scale, offset and a push forward/back slider fine-tune it. With a background chosen, points sit on the background and read its depth, and cuts use the background's depth scale. Files → Merged video saves the result.
