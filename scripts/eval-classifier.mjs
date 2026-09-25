#!/usr/bin/env node
// Offline evaluation of the Gemini photo classifier.
//
// Uses the exact prompt, payload and parser the live pipeline uses
// (lib/geminiClassifier.ts, loaded via Node's built-in TypeScript type
// stripping, Node >= 22.18 / 23.6), runs it over a labelled photo set, and
// writes public/eval/classifier-eval.json, which the dashboard's
// "Model quality" card displays.
//
// Photo layout (see eval/README.md):
//   eval/photos/<label>/<image>.jpg
//   label ∈ smoke | dust | haze | fire | clear | unclear  (or pollution | no_pollution)
//
// Usage:  GEMINI_API_KEY=... npm run eval:classifier

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  CLASSIFICATION_MODELS,
  buildClassificationPayload,
  isPollutionClassification,
  parseClassification,
} from "../lib/geminiClassifier.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local") });

const PHOTO_DIR = path.join(root, "eval", "photos");
const OUTPUT = path.join(root, "public", "eval", "classifier-eval.json");
const POLLUTION_LABELS = new Set(["smoke", "dust", "haze", "fire", "pollution"]);
const KNOWN_LABELS = new Set([...POLLUTION_LABELS, "clear", "unclear", "no_pollution"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const CONCURRENCY = 3;

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set (env or .env.local).");
  process.exit(1);
}
if (!existsSync(PHOTO_DIR)) {
  console.error(`No photo set at ${PHOTO_DIR}. See eval/README.md.`);
  process.exit(1);
}

const samples = readdirSync(PHOTO_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && KNOWN_LABELS.has(entry.name))
  .flatMap((dir) =>
    readdirSync(path.join(PHOTO_DIR, dir.name))
      .filter((file) => MIME[path.extname(file).toLowerCase()])
      .map((file) => ({ label: dir.name, file: path.join(PHOTO_DIR, dir.name, file) })),
  );

if (samples.length === 0) {
  console.error("No labelled images found. Expected eval/photos/<label>/*.jpg");
  process.exit(1);
}

async function classify(sample) {
  const payload = buildClassificationPayload({
    data: readFileSync(sample.file).toString("base64"),
    mimeType: MIME[path.extname(sample.file).toLowerCase()],
  });
  let lastError;
  for (const model of CLASSIFICATION_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      return { model, classification: parseClassification(text) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const results = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < samples.length) {
      const sample = samples[cursor++];
      try {
        const { model, classification } = await classify(sample);
        results.push({ ...sample, model, classification });
        process.stdout.write(".");
      } catch (error) {
        results.push({ ...sample, error: error instanceof Error ? error.message : String(error) });
        process.stdout.write("x");
      }
    }
  }),
);
process.stdout.write("\n");

const scored = results.filter((result) => result.classification);
let tp = 0, fp = 0, tn = 0, fn = 0;
const perLabel = {};
for (const result of scored) {
  const expected = POLLUTION_LABELS.has(result.label);
  const predicted = isPollutionClassification(result.classification);
  if (expected && predicted) tp += 1;
  else if (!expected && predicted) fp += 1;
  else if (!expected && !predicted) tn += 1;
  else fn += 1;

  const bucket = (perLabel[result.label] ??= { total: 0, binaryCorrect: 0, exactType: 0 });
  bucket.total += 1;
  if (expected === predicted) bucket.binaryCorrect += 1;
  if (result.classification.type === result.label) bucket.exactType += 1;
}

const ratio = (numerator, denominator) => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)));
const precision = ratio(tp, tp + fp);
const recall = ratio(tp, tp + fn);
const report = {
  generatedAt: new Date().toISOString(),
  model: [...new Set(scored.map((result) => result.model))].join(", "),
  total: scored.length,
  errors: results.length - scored.length,
  binary: {
    precision,
    recall,
    f1: precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null,
    accuracy: ratio(tp + tn, scored.length),
    tp, fp, tn, fn,
  },
  perLabel,
  misclassified: scored
    .filter((result) => POLLUTION_LABELS.has(result.label) !== isPollutionClassification(result.classification))
    .map((result) => ({
      file: path.relative(root, result.file),
      label: result.label,
      predicted: result.classification.type,
      confidence: result.classification.confidence,
    })),
};

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Evaluated ${report.total} images (${report.errors} errors).`);
console.log(`Precision ${precision} · Recall ${recall} · F1 ${report.binary.f1} · Accuracy ${report.binary.accuracy}`);
console.log(`Wrote ${path.relative(root, OUTPUT)}`);
