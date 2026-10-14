/**
 * person-detect.mjs — continuous stream analysis for the v2 away-mode
 * indoor watch (security-guard program, Stage 5). Written fresh for this
 * build; shared by app/away-watch.mjs (live chain) and the offline
 * detector proof harness (hidden_files/away-watch-proof/).
 *
 * Design (Away-mode-indoor-watch-v2-design.md §3.1, REVISED — sampling
 * is NOT the detection mechanism):
 *   1. Motion gate — frame differencing over a downscaled analysis feed
 *      (300x300 RGB at ANALYSIS_FPS). Cheap; runs on every analysis
 *      frame. A person crossing the room in 2-5 s spans 12-30 analysis
 *      frames, so the gate cannot step over a crossing.
 *   2. Person classifier — SSD-MobileNet v1 (ONNX Model Zoo, opset 12;
 *      nano-class detector, COCO person = class 1) via onnxruntime-node,
 *      run at up to ~4 fps on motion-active frames, plus a hold window:
 *      for PERSON_HOLD_SEC after the last motion, classification keeps
 *      running at ~1 fps so a person who stops moving is still seen.
 *      A trigger needs person detections in 2 classifications within
 *      2.5 s (debounce against single-frame artifacts), then a cooldown
 *      suppresses re-triggers for the same continuous presence.
 *   3. Ring buffer — the full-resolution stream is written by ffmpeg as
 *      rolling ~30 s MPEG-TS segments (~12 min retained). A trigger
 *      cuts the -30 s / +30 s window around it into an incident MP4.
 *
 * The detector is a HINT GENERATOR, never the judge: GG watches every
 * incident segment and decides (design §3.2). Thresholds are therefore
 * tuned for recall; the staged accuracy proof (PROOF.md) is the gate
 * for trusting the alert path.
 *
 * Model: ssd_mobilenet_v1_12.onnx, sha256
 * b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058
 * (ONNX Model Zoo; fetched at workflow setup, cached — see
 * away-watch.yml). Input "image_tensor": uint8 NHWC [1,300,300,3].
 * Outputs: detection_boxes [1,N,4] (ymin,xmin,ymax,xmax normalized),
 * detection_classes [1,N] (COCO ids as float), detection_scores [1,N],
 * num_detections [1]. The zoo model runs NMS in-graph.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const ANALYSIS_W = 300;
export const ANALYSIS_H = 300;
export const ANALYSIS_FPS = 6; // analysis frames per second from ffmpeg
const FRAME_BYTES = ANALYSIS_W * ANALYSIS_H * 3;
export const PERSON_CLASS = 1; // COCO: person
export const DOG_CLASS = 18; // COCO: dog (reported in proofs; never triggers)

const DEFAULTS = {
    confThreshold: 0.5, // person score at/above this counts as a detection
    motionMeanMin: 1.0, // mean abs luminance diff (0-255) that marks motion
    classifyIntervalMs: 250, // ~4 fps classifier cap while motion is active
    holdClassifyIntervalMs: 1_000, // ~1 fps during the post-motion hold
    personHoldSec: 10, // keep classifying this long after the last motion
    triggerWindowMs: 2_500, // 2 person classifications inside this window
    triggerHits: 2,
    cooldownMs: 90_000, // re-trigger suppression for continuous presence
    segmentSec: 30, // ring segment target duration
    ringKeepMs: 12 * 60_000, // ring retention (~10 min + margin)
    preSec: 30, // incident window before the trigger
    postSec: 30, // incident window after the trigger
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);

// ---------------------------------------------------------------------------
// person detector (SSD-MobileNet v1 via onnxruntime-node)
// ---------------------------------------------------------------------------
export async function createPersonDetector({ modelPath, confThreshold = DEFAULTS.confThreshold, log = () => {} } = {}) {
    if (!modelPath || !fs.existsSync(modelPath)) throw new Error(`detector model not found at ${modelPath}`);
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(modelPath);
    const inputName = session.inputNames[0];
    const outputNames = session.outputNames;
    log(`detector: inputs=[${session.inputNames.join(",")}] outputs=[${outputNames.join(",")}]`);
    let inputType = "uint8"; // zoo spec; verified on first run, float32 fallback

    function pickOutputs(results) {
        // Map by name when the zoo names are present; else by tensor shape.
        const byName = {};
        for (const name of outputNames) byName[name] = results[name];
        let boxes = byName["detection_boxes"] ?? byName["boxes"];
        let classes = byName["detection_classes"] ?? byName["classes"];
        let scores = byName["detection_scores"] ?? byName["scores"];
        let num = byName["num_detections"] ?? byName["num"];
        if (!boxes || !classes || !scores) {
            for (const name of outputNames) {
                const t = results[name];
                const dims = t?.dims ?? [];
                if (dims.length === 3 && dims[2] === 4) boxes = t;
                else if (dims.length === 2 && dims[0] === 1) {
                    if (!scores) scores = t;
                    else if (!classes) classes = t;
                } else if (dims.length <= 1 && !num) num = t;
            }
        }
        return { boxes, classes, scores, num };
    }

    /** rgb: Buffer/Uint8Array of ANALYSIS_W*ANALYSIS_H*3 bytes (RGB24). */
    async function detect(rgb) {
        if (!rgb || rgb.length !== FRAME_BYTES) throw new Error(`detect: expected ${FRAME_BYTES} bytes, got ${rgb?.length}`);
        const attempts = inputType === "uint8" ? ["uint8", "float32"] : ["float32", "uint8"];
        let lastErr = null;
        for (const type of attempts) {
            try {
                const data = type === "uint8" ? Uint8Array.from(rgb) : Float32Array.from(rgb);
                const tensor = new ort.Tensor(type, data, [1, ANALYSIS_H, ANALYSIS_W, 3]);
                const results = await session.run({ [inputName]: tensor });
                inputType = type; // remember the working encoding
                const { boxes, classes, scores, num } = pickOutputs(results);
                if (!boxes || !classes || !scores) throw new Error("detector outputs not recognized");
                const n = num ? Math.round(num.data[0]) : scores.data.length;
                const out = [];
                for (let i = 0; i < Math.min(n, scores.data.length); i++) {
                    const score = scores.data[i];
                    if (score < confThreshold) continue;
                    out.push({
                        classId: Math.round(classes.data[i]),
                        score,
                        box: [boxes.data[i * 4], boxes.data[i * 4 + 1], boxes.data[i * 4 + 2], boxes.data[i * 4 + 3]],
                    });
                }
                return out;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr ?? new Error("detector run failed");
    }

    return {
        detect,
        async personInFrame(rgb) {
            const dets = await detect(rgb);
            const people = dets.filter((d) => d.classId === PERSON_CLASS);
            return { people, dets };
        },
        close() {
            try {
                session.release?.();
            } catch {
                /* ignore */
            }
        },
    };
}

// ---------------------------------------------------------------------------
// frame analyzer: motion gate + throttled classifier + trigger debounce
// ---------------------------------------------------------------------------
export class FrameAnalyzer {
    constructor({ detector, onTrigger, log = () => {}, opts = {} }) {
        this.detector = detector;
        this.onTrigger = onTrigger;
        this.log = log;
        this.cfg = { ...DEFAULTS, ...opts };
        this.prevLum = null;
        this.lastMotionMs = -Infinity;
        this.lastClassifyMs = -Infinity;
        this.personFlags = []; // { atMs, score }
        this.cooldownUntilMs = -Infinity;
        this.classifyChain = Promise.resolve();
        this.stats = { frames: 0, motionFrames: 0, classified: 0, personClassifications: 0, triggers: 0, maxMeanDiff: 0, lastPerson: null };
    }

    /** Mean abs luminance diff vs the previous frame (sampled every 3rd pixel). */
    meanDiff(rgb) {
        const lum = new Float32Array(ANALYSIS_W * ANALYSIS_H);
        for (let i = 0, j = 0; i < rgb.length; i += 3, j++) lum[j] = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
        if (!this.prevLum) {
            this.prevLum = lum;
            return 0;
        }
        let sum = 0;
        let n = 0;
        for (let j = 0; j < lum.length; j += 3) {
            sum += Math.abs(lum[j] - this.prevLum[j]);
            n++;
        }
        this.prevLum = lum;
        return sum / n;
    }

    /** Feed one analysis frame (300x300 RGB24) with its wall-clock timestamp. */
    pushFrame(rgb, atMs) {
        this.stats.frames++;
        const diff = this.meanDiff(rgb);
        if (diff > this.stats.maxMeanDiff) this.stats.maxMeanDiff = diff;
        const motion = diff >= this.cfg.motionMeanMin;
        if (motion) {
            this.stats.motionFrames++;
            this.lastMotionMs = atMs;
        }
        const inHold = atMs - this.lastMotionMs <= this.cfg.personHoldSec * 1000;
        const interval = motion ? this.cfg.classifyIntervalMs : this.holdClassifyIntervalMs;
        if ((motion || inHold) && atMs - this.lastClassifyMs >= interval) {
            this.lastClassifyMs = atMs;
            const frameCopy = Buffer.from(rgb);
            this.classifyChain = this.classifyChain
                .then(() => this.classify(frameCopy, atMs))
                .catch((e) => this.log(`analyzer: classify error: ${shortErr(e)}`));
        }
        return this.classifyChain;
    }

    async classify(rgb, atMs) {
        this.stats.classified++;
        const { people } = await this.detector.personInFrame(rgb);
        if (people.length === 0) return;
        const best = people.reduce((a, b) => (b.score > a.score ? b : a));
        this.stats.personClassifications++;
        this.stats.lastPerson = { atMs, score: best.score };
        this.log(`analyzer: person classification at ${new Date(atMs).toISOString()} score=${best.score.toFixed(2)}`);
        if (atMs < this.cooldownUntilMs) return;
        this.personFlags = this.personFlags.filter((f) => atMs - f.atMs <= this.cfg.triggerWindowMs);
        this.personFlags.push({ atMs, score: best.score });
        if (this.personFlags.length >= this.cfg.triggerHits) {
            const trigger = {
                atMs: this.personFlags[0].atMs,
                confidence: Math.max(...this.personFlags.map((f) => f.score)),
                hits: this.personFlags.length,
            };
            this.personFlags = [];
            this.cooldownUntilMs = atMs + this.cfg.cooldownMs;
            this.stats.triggers++;
            this.log(`analyzer: PERSON TRIGGER at ${new Date(trigger.atMs).toISOString()} confidence=${trigger.confidence.toFixed(2)}`);
            await this.onTrigger(trigger);
        }
    }

    async drain() {
        await this.classifyChain;
    }
}

// ---------------------------------------------------------------------------
// ring buffer: rolling ffmpeg TS segments + incident cutting
// ---------------------------------------------------------------------------
function probeDurationMs(file) {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
    const d = parseFloat((r.stdout || "").trim());
    return Number.isFinite(d) ? Math.round(d * 1000) : null;
}

export class RingBuffer {
    constructor(dir, { log = () => {}, opts = {} } = {}) {
        this.dir = dir;
        this.log = log;
        this.cfg = { ...DEFAULTS, ...opts };
        this.entries = []; // { file, startMs, endMs } closed segments, ordered
        this.pins = new Map(); // file -> pin count (in-flight cuts)
        fs.mkdirSync(dir, { recursive: true });
    }

    /** Index newly closed segments (a segment is closed once a newer one exists). */
    poll() {
        const files = fs
            .readdirSync(this.dir)
            .filter((f) => /^seg-\d+\.ts$/.test(f))
            .sort();
        for (let i = 0; i < files.length - 1; i++) {
            const file = path.join(this.dir, files[i]);
            if (this.entries.some((e) => e.file === file)) continue;
            const dur = probeDurationMs(file);
            if (!dur) continue;
            const endMs = Math.round(fs.statSync(file).mtimeMs);
            this.entries.push({ file, startMs: endMs - dur, endMs });
            this.log(`ring: segment closed ${files[i]} (${(dur / 1000).toFixed(1)}s, ends ${new Date(endMs).toISOString()})`);
        }
        this.entries.sort((a, b) => a.startMs - b.startMs);
    }

    prune(nowMs) {
        const cutoff = nowMs - this.cfg.ringKeepMs;
        const keep = [];
        for (const e of this.entries) {
            if (e.endMs < cutoff && !this.pins.get(e.file)) {
                try {
                    fs.unlinkSync(e.file);
                } catch {
                    /* already gone */
                }
            } else keep.push(e);
        }
        this.entries = keep;
    }

    covers(fromMs, toMs) {
        return this.entries.some((e) => e.startMs <= fromMs) && this.entries.some((e) => e.endMs >= toMs);
    }

    /**
     * Cut [fromMs, toMs] into outPath (MP4). Stream-copy first (keyframe
     * granularity ~one GOP), re-encode fallback. Returns the actual span.
     */
    async cut(fromMs, toMs, outPath) {
        this.poll();
        const segs = this.entries.filter((e) => e.endMs > fromMs && e.startMs < toMs);
        if (segs.length === 0) throw new Error(`ring has no segments covering ${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()}`);
        for (const s of segs) this.pins.set(s.file, (this.pins.get(s.file) ?? 0) + 1);
        const tmpTs = `${outPath}.joined.ts`;
        const listFile = `${outPath}.concat.txt`;
        try {
            fs.writeFileSync(listFile, segs.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join("\n"));
            let r = spawnSync("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", tmpTs], { encoding: "utf8" });
            if (r.status !== 0) throw new Error(`concat failed: ${(r.stderr || "").slice(0, 200)}`);
            const offsetSec = Math.max(0, (fromMs - segs[0].startMs) / 1000);
            const durSec = (toMs - fromMs) / 1000;
            const base = ["-v", "error", "-ss", String(offsetSec), "-t", String(durSec), "-i", tmpTs];
            r = spawnSync("ffmpeg", [...base, "-c", "copy", "-movflags", "+faststart", "-y", outPath], { encoding: "utf8" });
            if (r.status !== 0 || !fs.existsSync(outPath)) {
                r = spawnSync("ffmpeg", [...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", "-movflags", "+faststart", "-y", outPath], { encoding: "utf8" });
                if (r.status !== 0) throw new Error(`re-encode failed: ${(r.stderr || "").slice(0, 200)}`);
            }
            const actualDur = probeDurationMs(outPath);
            if (!actualDur || actualDur < 500) throw new Error("cut produced an empty/unreadable MP4");
            return { path: outPath, durationSec: actualDur / 1000, segments: segs.length };
        } finally {
            for (const s of segs) {
                const n = (this.pins.get(s.file) ?? 1) - 1;
                if (n <= 0) this.pins.delete(s.file);
                else this.pins.set(s.file, n);
            }
            for (const f of [tmpTs, listFile]) {
                try {
                    fs.unlinkSync(f);
                } catch {
                    /* ignore */
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// live pipeline: client livestream -> ffmpeg (ring segments + analysis feed)
// ---------------------------------------------------------------------------
export function spawnLivePipeline({ videoStream, codec, ringDir, analyzer, log = () => {} }) {
    const ring = new RingBuffer(ringDir, { log });
    const fmt = codec === 1 ? "hevc" : codec === 0 ? "h264" : null;
    const args = ["-hide_banner", "-loglevel", "warning"];
    if (fmt) args.push("-f", fmt);
    else args.push("-probesize", "1048576");
    args.push(
        "-i", "pipe:0",
        "-map", "0:v:0", "-c:v", "copy", "-f", "segment", "-segment_time", String(ring.cfg.segmentSec),
        "-reset_timestamps", "1", "-segment_format", "mpegts", path.join(ringDir, "seg-%05d.ts"),
        "-map", "0:v:0", "-vf", `scale=${ANALYSIS_W}:${ANALYSIS_H},fps=${ANALYSIS_FPS}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    );
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderrTail = "";
    ff.stderr.on("data", (c) => {
        stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    let bytesIn = 0;
    videoStream.on("data", (c) => {
        bytesIn += c.length;
    });
    videoStream.pipe(ff.stdin);
    ff.stdin.on("error", () => {}); // EPIPE on shutdown is expected
    let acc = Buffer.alloc(0);
    ff.stdout.on("data", (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= FRAME_BYTES) {
            const frame = acc.subarray(0, FRAME_BYTES);
            acc = acc.subarray(FRAME_BYTES);
            analyzer.pushFrame(Buffer.from(frame), Date.now());
        }
    });
    const exited = new Promise((resolve) => {
        ff.on("exit", (code, signal) => resolve({ code, signal, stderrTail }));
        ff.on("error", (e) => resolve({ code: -1, signal: null, stderrTail: shortErr(e) }));
    });
    return {
        ring,
        bytesIn: () => bytesIn,
        exited,
        async stop() {
            try {
                videoStream.unpipe(ff.stdin);
            } catch {
                /* ignore */
            }
            try {
                ff.stdin.end();
            } catch {
                /* ignore */
            }
            const done = await Promise.race([exited, sleep(5_000).then(() => null)]);
            if (!done) {
                try {
                    ff.kill("SIGKILL");
                } catch {
                    /* ignore */
                }
                await exited;
            }
            ring.poll();
        },
    };
}

// ---------------------------------------------------------------------------
// offline file analysis (detector proof): same analyzer, file as the ring
// ---------------------------------------------------------------------------
export async function analyzeVideoFile(filePath, { modelPath, outDir, log = () => {}, opts = {} } = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const durationMs = probeDurationMs(filePath);
    if (!durationMs) throw new Error(`cannot probe ${filePath}`);
    const detector = await createPersonDetector({ modelPath, confThreshold: cfg.confThreshold, log });
    const triggers = [];
    const personDetections = [];
    const dogDetections = [];
    // Wrap the detector so the proof records every person/dog classification.
    const recordingDetector = {
        async personInFrame(rgb) {
            const dets = await detector.detect(rgb);
            const people = dets.filter((d) => d.classId === PERSON_CLASS);
            const dogs = dets.filter((d) => d.classId === DOG_CLASS);
            return { people, dets, _dogs: dogs };
        },
        close: () => detector.close(),
    };
    const analyzer = new FrameAnalyzer({
        detector: recordingDetector,
        opts: cfg,
        log,
        onTrigger: async (t) => {
            triggers.push(t);
        },
    });
    // Record detections with timestamps by shadowing classify().
    const origClassify = analyzer.classify.bind(analyzer);
    analyzer.classify = async (rgb, atMs) => {
        const before = analyzer.stats.personClassifications;
        await origClassify(rgb, atMs);
        if (analyzer.stats.personClassifications > before && analyzer.stats.lastPerson) {
            personDetections.push({ atSec: analyzer.stats.lastPerson.atMs / 1000, score: analyzer.stats.lastPerson.score });
        }
    };

    const ff = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", filePath,
        "-vf", `scale=${ANALYSIS_W}:${ANALYSIS_H},fps=${ANALYSIS_FPS}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (c) => (stderr += c.toString()));
    let acc = Buffer.alloc(0);
    let frameIdx = 0;
    const frameMs = 1000 / ANALYSIS_FPS;
    await new Promise((resolve, reject) => {
        ff.stdout.on("data", (chunk) => {
            acc = Buffer.concat([acc, chunk]);
            while (acc.length >= FRAME_BYTES) {
                const frame = acc.subarray(0, FRAME_BYTES);
                acc = acc.subarray(FRAME_BYTES);
                analyzer.pushFrame(Buffer.from(frame), Math.round(frameIdx * frameMs));
                frameIdx++;
            }
        });
        ff.on("error", reject);
        ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg decode failed (${code}): ${stderr.slice(0, 200)}`))));
    });
    await analyzer.drain();
    detector.close();

    // Cut one incident segment per trigger, clamped to the file's bounds.
    fs.mkdirSync(outDir, { recursive: true });
    const segments = [];
    for (let i = 0; i < triggers.length; i++) {
        const t = triggers[i];
        const fromMs = Math.max(0, t.atMs - cfg.preSec * 1000);
        const toMs = Math.min(durationMs, t.atMs + cfg.postSec * 1000);
        const outPath = path.join(outDir, `segment-${i + 1}.mp4`);
        const base = ["-v", "error", "-ss", String(fromMs / 1000), "-t", String((toMs - fromMs) / 1000), "-i", filePath];
        let r = spawnSync("ffmpeg", [...base, "-c", "copy", "-movflags", "+faststart", "-y", outPath], { encoding: "utf8" });
        if (r.status !== 0 || !fs.existsSync(outPath)) {
            r = spawnSync("ffmpeg", [...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", "-movflags", "+faststart", "-y", outPath], { encoding: "utf8" });
        }
        const framePath = path.join(outDir, `segment-${i + 1}-trigger-frame.jpg`);
        spawnSync("ffmpeg", ["-v", "error", "-ss", String(t.atMs / 1000), "-i", filePath, "-frames:v", "1", "-q:v", "3", "-y", framePath], { encoding: "utf8" });
        segments.push({
            triggerAtSec: t.atMs / 1000,
            confidence: t.confidence,
            fromSec: fromMs / 1000,
            toSec: toMs / 1000,
            path: outPath,
            durationSec: probeDurationMs(outPath) ? probeDurationMs(outPath) / 1000 : null,
            triggerFrame: fs.existsSync(framePath) ? framePath : null,
        });
    }
    return {
        file: filePath,
        durationSec: durationMs / 1000,
        stats: analyzer.stats,
        personDetections,
        dogDetections,
        triggers: triggers.map((t) => ({ atSec: t.atMs / 1000, confidence: t.confidence, hits: t.hits })),
        segments,
    };
}
