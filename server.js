// ============================================================
// Audio Finder - Backend Server
// Uses yt-dlp-exec to download audio + ffmpeg-static to convert
// to MP3. Both install automatically via npm — no manual setup!
// ============================================================

const express = require("express");
const ytDlp = require("yt-dlp-exec");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static"); // auto-downloaded binary!
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

// Tell fluent-ffmpeg to use the bundled ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 3000;

// ---------------------
// Middleware
// ---------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------
// Rate Limiting
// ---------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many requests. Please wait a few minutes and try again." },
});
app.use("/extract", limiter);

// ---------------------
// Temp folder for processing
// ---------------------
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// Clean up a file after a delay
function cleanUp(filePath, delayMs = 120000) {
  setTimeout(() => fs.unlink(filePath, () => {}), delayMs);
}

// Clean all tmp files on server start
fs.readdirSync(TMP_DIR).forEach((f) => fs.unlinkSync(path.join(TMP_DIR, f)));

// ---------------------
// Helper: validate URL
// ---------------------
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

// ---------------------
// GET /info?url=...
// Returns video title as JSON (fast, no download)
// ---------------------
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: "Please provide a valid URL." });

  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    res.json({ title: info.title || "Audio" });
  } catch (err) {
    const msg = (err.stderr || err.message || "").toLowerCase();
    if (msg.includes("private"))   return res.status(400).json({ error: "This video is private." });
    if (msg.includes("age"))       return res.status(400).json({ error: "This video has age restrictions." });
    if (msg.includes("available")) return res.status(400).json({ error: "This video is unavailable." });
    res.status(500).json({ error: "Could not fetch video info. Check the URL and try again." });
  }
});

// ---------------------
// GET /extract?url=...
// Downloads audio via yt-dlp, converts to MP3 via ffmpeg-static,
// streams the MP3 back to the browser.
// ---------------------
app.get("/extract", async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: "Please provide a valid URL." });

  const id = randomUUID();
  const rawPath = path.join(TMP_DIR, `${id}.webm`); // downloaded raw audio
  const mp3Path = path.join(TMP_DIR, `${id}.mp3`);  // converted MP3

  try {
    console.log("Downloading audio for:", url);

    // Step 1: Download best audio to a temp file using yt-dlp
    await ytDlp(url, {
      output: rawPath,           // save to temp file
      format: "bestaudio",       // best quality audio
      noWarnings: true,
      noCheckCertificates: true,
    });

    console.log("Converting to MP3...");

    // Step 2: Convert the downloaded audio to MP3 using bundled ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .audioBitrate(128)       // 128kbps — good quality, smaller file
        .toFormat("mp3")
        .save(mp3Path)
        .on("end", resolve)
        .on("error", reject);
    });

    // Clean up the raw file now that we have the MP3
    fs.unlink(rawPath, () => {});

    console.log("Sending MP3 to browser...");

    // Step 3: Send the MP3 file to the browser
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes"); // enables seeking in the audio player

    const stat = fs.statSync(mp3Path);
    res.setHeader("Content-Length", stat.size);

    // Stream the MP3 to the client
    const fileStream = fs.createReadStream(mp3Path);
    fileStream.pipe(res);

    // Clean up the MP3 file 2 minutes after sending
    fileStream.on("close", () => cleanUp(mp3Path, 120000));

  } catch (err) {
    // Clean up any leftover files on error
    fs.unlink(rawPath, () => {});
    fs.unlink(mp3Path, () => {});

    console.error("Extraction error:", err.stderr || err.message);
    const msg = (err.stderr || err.message || "").toLowerCase();

    if (!res.headersSent) {
      if (msg.includes("private"))   return res.status(400).json({ error: "This video is private." });
      if (msg.includes("age"))       return res.status(400).json({ error: "Age-restricted video." });
      if (msg.includes("available")) return res.status(400).json({ error: "Video unavailable or removed." });
      return res.status(500).json({ error: "Could not extract audio. Please try again." });
    }
  }
});

// ---------------------
// Start Server
// ---------------------
app.listen(PORT, () => {
  console.log(`\n🎵 Audio Finder running at http://localhost:${PORT}\n`);
});
