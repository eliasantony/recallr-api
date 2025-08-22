import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const pExec = promisify(execFile);

export async function downscaleForGemini(inputPath) {
  const w   = Number(process.env.VIDEO_DOWNSCALE_W || 720);
  const fps = Number(process.env.VIDEO_DOWNSCALE_FPS || 2);
  const out = inputPath.replace(/\.(mp4|mov|m4v)$/i, `.gemini.${w}w.${fps}fps.mp4`);
  const vf  = `scale='min(${w},iw)':'-2',fps=${fps}`;

  await pExec("ffmpeg", ["-y", "-i", inputPath, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-an", out]);
  return out;
}