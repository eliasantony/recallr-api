import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const pExecFile = promisify(execFile);

// --- config helpers ---
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";
const JSON_DIR = path.join(DOWNLOAD_DIR, "json");
const CACHE_DIR = path.join(DOWNLOAD_DIR, "cache");
const COOKIES_FILE = process.env.COOKIES_FILE;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000); // 24h

for (const d of [DOWNLOAD_DIR, JSON_DIR, CACHE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// --- utils ---
export function hostnameAllowed(urlString, allowedHosts) {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return allowedHosts.length === 0 || allowedHosts.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function toISO(timestamp, uploadDate) {
  if (timestamp) return new Date(timestamp * 1000).toISOString();
  if (/^\d{8}$/.test(uploadDate || "")) {
    const y = +uploadDate.slice(0, 4), m = +uploadDate.slice(4, 6) - 1, d = +uploadDate.slice(6, 8);
    return new Date(Date.UTC(y, m, d)).toISOString();
  }
  return null;
}

function normalize(info) {
  const authorName = info.uploader || info.channel || info.creator || null;
  const authorId   = info.uploader_id || info.channel_id || info.creator_id || null;
  return {
    platform: (info.extractor_key || "").toLowerCase(),   // youtube | tiktok | instagram
    url: info.webpage_url,
    post_id: info.id,
    title: info.title,
    caption: info.description,
    author: { name: authorName, id: authorId },
    published_at: toISO(info.timestamp, info.upload_date),
    stats: {
      views: info.view_count ?? null,
      likes: info.like_count ?? null,
      comments: info.comment_count ?? null
    },
    duration_sec: info.duration ?? null,
    // keep thumbnails in raw only; we won't return them in API later
    raw: { extractor: info.extractor, ext: info.ext, uploader_url: info.uploader_url || null, thumbnails: info.thumbnails || [] }
  };
}

function postDirFor(info, downloadDir = DOWNLOAD_DIR) {
  const safePlatform = ((info.extractor_key || "").toLowerCase().split(":")[0] || "post");
  return path.join(downloadDir, `${safePlatform}-${info.id}`);
}

function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }
function cachePathForUrl(url) { return path.join(CACHE_DIR, `${sha1(url)}.json`); }
function isFresh(file) {
  try { const st = fs.statSync(file); return Date.now() - st.mtimeMs < CACHE_TTL_MS; }
  catch { return false; }
}
export function readCache(url) {
  const f = cachePathForUrl(url);
  if (isFresh(f)) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch {} }
  return null;
}
export function writeCache(url, obj) {
  fs.writeFileSync(cachePathForUrl(url), JSON.stringify(obj, null, 2), "utf8");
}

// --- yt-dlp helpers ---
async function ytdlpJSON(url, { cookiesFile } = {}) {
  const args = ["-J", "--no-warnings", "--no-call-home", "--no-playlist", url];
  if (cookiesFile && fs.existsSync(cookiesFile)) args.unshift("--cookies", cookiesFile);
  const { stdout } = await pExecFile("yt-dlp", args, { maxBuffer: 1024 * 1024 * 50 });
  return JSON.parse(stdout);
}

async function ytdlpDownloadMergedMP4(url, outtmpl, { cookiesFile } = {}) {
  const args = [
    "-o", outtmpl,
    "--no-playlist",
    "-f", "bestvideo*+bestaudio/best",
    "--merge-output-format", "mp4",
    "--audio-multistreams",
    "--geo-bypass"
  ];
  if (cookiesFile && fs.existsSync(cookiesFile)) args.unshift("--cookies", cookiesFile);
  await pExecFile("yt-dlp", args.concat(url), { maxBuffer: 1024 * 1024 * 50 });
}

async function ytdlpDownloadSubsIfYouTube(info, url, outBase, { cookiesFile } = {}) {
  const isYouTube = (info.extractor_key || "").toLowerCase().includes("youtube");
  if (!isYouTube) return null;

  const args = [
    "-o", outBase,
    "--skip-download",
    "--sub-format", "vtt/srv3/srv2/srv1/ttml/best",
    "--write-subs",
    "--write-auto-subs",
    "--sub-lang", "de.*,en.*"
  ];
  if (cookiesFile && fs.existsSync(cookiesFile)) args.unshift("--cookies", cookiesFile);
  await pExecFile("yt-dlp", args.concat(url), { maxBuffer: 1024 * 1024 * 50 });

  const dir = path.dirname(outBase);
  const id  = path.basename(outBase);
  const files = fs.readdirSync(dir).filter(f => f.startsWith(id) && f.endsWith(".vtt"));
  if (files.length === 0) return null;

  // quick .vtt → text
  const text = files.map(f => fs.readFileSync(path.join(dir, f), "utf8"))
    .map(vtt => vtt
      .replace(/\r/g, "")
      .split("\n")
      .filter(line => line && !/^\d+$/.test(line) && !line.includes("-->") && !line.startsWith("WEBVTT"))
      .join("\n"))
    .join("\n");

  return text.trim() || null;
}

// --- ASR helpers (optional) ---
async function extractAudioWav(videoPath, wavPath) {
  await pExecFile("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", wavPath]);
  return wavPath;
}

/**
 * ASR via API (OpenAI Whisper or custom server).
 * Returns transcript text, or null on failure.
 */
export async function transcribeWithASRLocalOrAPI({ videoPath }) {
  const mode = (process.env.ASR_MODE || "api").toLowerCase(); // api | local
  const provider = (process.env.ASR_PROVIDER || "openai").toLowerCase();

  // Extract wav
  const wav = videoPath ? videoPath.replace(/\.(mp4|mov|m4v)$/i, ".wav") : null;
  if (!videoPath) return null;
  await extractAudioWav(videoPath, wav);

  // API path
  if (mode === "api") {
    if (provider === "openai") {
      // Uses global fetch in Node 18+; if you’re on older Node, install node-fetch.
      const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) return null;

      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(wav)]), path.basename(wav));
      form.append("model", "whisper-1");

      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data?.text || null;
    }

    // Custom Whisper server (OpenAI-compatible style)
    if (provider === "custom") {
      const base = process.env.ASR_BASE_URL;
      const key  = process.env.ASR_API_KEY;
      if (!base) return null;
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(wav)]), path.basename(wav));
      form.append("model", "whisper");
      const r = await fetch(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        body: form
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data?.text || null;
    }
  }

  // Local mode placeholder (run your own faster-whisper service and call it here)
  return null;
}

// --- main API used by server ---
/**
 * Extracts metadata, optionally downloads the merged (A+V) MP4, optionally gets transcript.
 * Saves normalized JSON to downloads/json/<post_id>.json.
 */
export async function extract(url, {
  downloadVideo = false,
  cookiesFile = COOKIES_FILE,
  downloadDir = DOWNLOAD_DIR,
  wantTranscript = false,
  refresh = false
} = {}) {

  // 0) cache?
  const cached = !refresh ? readCache(url) : null;
  if (cached) return cached;

  // 1) metadata
  const info = await ytdlpJSON(url, { cookiesFile });
  const postDir = postDirFor(info, downloadDir);
  if (!fs.existsSync(postDir)) fs.mkdirSync(postDir, { recursive: true });

  // 2) video (merged mp4)
  let downloadedPath = null;
  if (downloadVideo) {
    const outtmpl = path.join(postDir, "%(id)s.%(ext)s");
    await ytdlpDownloadMergedMP4(url, outtmpl, { cookiesFile });
    const guessMp4 = path.join(postDir, `${info.id}.mp4`);
    downloadedPath = fs.existsSync(guessMp4) ? guessMp4 : null;
  }

  // 3) transcript (YouTube subs only here)
  let transcript = null;
  if (wantTranscript) {
    const outBase = path.join(postDir, info.id); // yt-dlp appends .xx.vtt
    try { transcript = await ytdlpDownloadSubsIfYouTube(info, url, outBase, { cookiesFile }); }
    catch { transcript = null; }
    if (transcript) {
      fs.writeFileSync(path.join(postDir, "transcript.txt"), transcript, "utf8");
    }
  }

  // 4) normalize + save JSON (per-post folder)
  const normalized = {
    ...normalize(info),
    transcript, // null if none
    video: { downloaded_path: downloadedPath },
  };

  const metaPath = path.join(postDir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(normalized, null, 2), "utf8");

  // cache (keeps the object small—no thumbnails in top-level fields)
  writeCache(url, { ...normalized, paths: { dir: postDir, meta_json: metaPath, video: downloadedPath, transcript_txt: transcript ? path.join(postDir, "transcript.txt") : null } });

  return { ...normalized, paths: { dir: postDir, meta_json: metaPath, video: downloadedPath, transcript_txt: transcript ? path.join(postDir, "transcript.txt") : null } };
}