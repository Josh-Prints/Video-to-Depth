# Video-to-Depth

Upload a video to `input/`. GitHub Actions runs [Video Depth Anything](https://github.com/DepthAnything/Video-Depth-Anything) on it, using the official weights from Hugging Face, and commits the depth video to `output/`. Nothing runs on your phone, so you can close the tab.

## Easiest: the upload page
**https://josh-prints.github.io/Video-to-Depth/** (once GitHub Pages is on: Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, folder `/docs`).

Everything happens on that page: log in, upload a clip, watch a live progress bar with a time estimate, preview the depth and source videos, save them to your phone, and download the 16-bit PNG frames as a zip. You can close it while a job runs.

Login: on first visit you paste a **fine-grained token** (this repo only, **Contents: Read and write**, **Actions: Read-only**) and choose a passcode. The token is stored encrypted with that passcode in the browser. After that you log in with the passcode; a login lasts 8 hours or until you close the tab.

The login locks the page, not the repo. While the repo is public, the files in `input/` and `output/` are still visible on github.com.

Progress is published by the workflow to `progress.json` on the `status` branch. PNG zips are attached to releases tagged `png-<name>`.

## Or upload through github.com
1. On github.com, open this repo, tap **Add file → Upload files**, pick your clip, and tap **Commit changes**.
2. Open the **Actions** tab. A "Depth video" run starts automatically.
3. When it goes green, open `output/`:
   - `<name>_depth.mp4`: grayscale depth. **White = near, black = far.** One brightness scale covers the whole clip, so the wall and the hand are comparable across frames.
   - `<name>_src.mp4`: the exact frames the depth was made from, with the same size, fps and frame count. Line this up against the depth, not your original.
4. For a **16-bit PNG depth sequence** (smoother displacement than 8-bit video), open the run's page and download the `depth-output` artifact at the bottom.

Accepted: `.mov .mp4 .m4v .mkv .webm .avi .3gp .mts .m2ts .ts .wmv .flv .mpg .mpeg .hevc .gif`. Audio files (`.mp3`, `.wav` etc.) are skipped, since they have no picture.

Every input gets re-encoded first: phone rotation is baked in, HEVC is converted to H.264, audio is dropped, the long side is capped at 1280 and the frame rate at 30. Clips that already have output are skipped.

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
