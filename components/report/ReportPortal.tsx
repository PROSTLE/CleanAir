"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import Link from "next/link";
import { defaultLocation, hazardTags } from "@/components/report/reportData";
import ReportLocationPicker from "@/components/report/ReportLocationPicker";
import Navbar from "@/components/shared/Navbar";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { hasPollutionSignal, type FirestoreReport } from "@/lib/firestoreReports";
import { submitCitizenReport } from "@/lib/reportSubmissions";
import { useLanguage, useT } from "@/lib/languageContext";

// Google Cloud Speech-to-Text language codes, keyed by our locale codes.
const SPEECH_LOCALE_MAP: Record<string, string> = {
  as: "as-IN",
  bn: "bn-IN",
  en: "en-IN",
  gu: "gu-IN",
  hi: "hi-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  or: "or-IN",
  pa: "pa-IN",
  ta: "ta-IN",
  te: "te-IN",
  ur: "ur-IN",
};

type SubmitState = "idle" | "submitting" | "submitted" | "error";
type ClassificationFeedback =
  | {
      tone: "accepted" | "neutral" | "error" | "processing";
      message: string;
    }
  | null;

const MAX_SOURCE_IMAGE_BYTES = 6_000_000;
const MAX_UPLOAD_IMAGE_CHARS = 620_000;
const COMPRESSED_IMAGE_MAX_EDGE = 960;

// Voice input: how long a pause has to last before we auto-stop recording.
const SILENCE_STOP_MS = 1600;
// RMS volume (0-1) below which audio counts as "silence".
const SILENCE_VOLUME_THRESHOLD = 0.02;
// Ignore silence detection for the first moment, so pausing to think doesn't cut it off instantly.
const SILENCE_GRACE_MS = 700;

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that image. Try another photo."));
    image.src = dataUrl;
  });
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read that image. Try another photo."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read that image. Try another photo."));
    reader.readAsDataURL(file);
  });
}

async function compressPhotoForUpload(file: File) {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Choose a photo under 6 MB for the demo upload.");
  }

  const originalDataUrl = await fileToDataUrl(file);
  const image = await loadImage(originalDataUrl);
  const scale = Math.min(
    1,
    COMPRESSED_IMAGE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare that image. Try another photo.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const qualityLevels = [0.72, 0.62, 0.52, 0.42];
  for (const quality of qualityLevels) {
    const compressed = canvas.toDataURL("image/jpeg", quality);
    if (compressed.length <= MAX_UPLOAD_IMAGE_CHARS) return compressed;
  }

  throw new Error("Choose a simpler or smaller image so it can upload safely.");
}

async function uploadPhotoToImgBB(dataUrl: string, fileName: string) {
  const response = await fetch("/api/upload-image", {
    body: JSON.stringify({
      image: dataUrl,
      name: `cleanair-${Date.now()}-${fileName.replace(/\.[^.]+$/, "")}`,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json()) as { error?: string; imageUrl?: string };

  if (!response.ok || !payload.imageUrl) {
    throw new Error(payload.error ?? "Could not upload photo.");
  }

  return payload.imageUrl;
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read that recording."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read that recording."));
    reader.readAsDataURL(blob);
  });
}

async function transcribeAudio(blob: Blob, languageCode: string, sampleRateHertz: number) {
  if (blob.size < 4000) {
    throw new Error("That recording was too short to transcribe. Hold the button and speak clearly.");
  }
  const audio = await blobToBase64(blob);
  const response = await fetch("/api/speech-to-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio, languageCode, sampleRateHertz }),
  });
  const payload = (await response.json()) as { error?: string; transcript?: string };
  if (!response.ok || !payload.transcript) {
    throw new Error(payload.error ?? "Could not transcribe that recording.");
  }
  return payload.transcript;
}

/* ── Step indicator icons ────────────────────────────────────────────── */
function StepIcon({ step }: { step: number }) {
  const icons = [
    // Camera / photo
    <svg key="cam" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
    // AI / scan
    <svg key="ai" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
    // Map pin / verified
    <svg key="pin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  ];
  return icons[step] ?? null;
}

export default function ReportPortal() {
  const t = useT();
  const { locale } = useLanguage();
  const [selectedTag, setSelectedTag] = useState(hazardTags[0].id);
  const [anonymous, setAnonymous] = useState(true);
  const [location, setLocation] = useState(defaultLocation);
  const [note, setNote] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState("");
  const [isPreparingPhoto, setIsPreparingPhoto] = useState(false);
  const [submissionId, setSubmissionId] = useState("");
  const [storedInFirebase, setStoredInFirebase] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [classificationFeedback, setClassificationFeedback] =
    useState<ClassificationFeedback>(null);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const recordingCleanupRef = useRef<(() => void) | null>(null);

  const selectedHazard = useMemo(
    () => hazardTags.find((tag) => tag.id === selectedTag) ?? hazardTags[0],
    [selectedTag],
  );
  const isNoSignalFeedback = classificationFeedback?.tone === "neutral";
  const isProcessingFeedback =
    classificationFeedback?.tone === "processing" ||
    (submitState === "submitted" && storedInFirebase && !classificationFeedback);

  useEffect(() => {
    if (!submissionId || !storedInFirebase || !isFirebaseConfigured || !db) return;

    return onSnapshot(doc(db, "reports", submissionId), (snapshot) => {
      if (!snapshot.exists()) return;

      const report = snapshot.data() as FirestoreReport;
      if (report.status === "pending") {
        setClassificationFeedback({
          message: "Analyzing your photo...",
          tone: "processing",
        });
        return;
      }

      if (report.status === "classification_failed") {
        const reason = report.classificationError ?? report.classificationAttemptError;
        setClassificationFeedback({
          message: reason
            ? `Automatic photo analysis failed: ${reason}`
            : "Report saved, but automatic photo analysis failed. It stays hidden until reviewed or retried.",
          tone: "error",
        });
        return;
      }

      if (report.status === "no_signal") {
        setClassificationFeedback({
          message:
            "We couldn't detect a clear pollution signal in this photo. It won't appear on the public map, but thanks for the report - feel free to try again with a clearer photo of the smoke, dust, or haze if you still see something.",
          tone: "neutral",
        });
        return;
      }

      if (report.status !== "classified" || !report.geminiClassification) return;

      if (hasPollutionSignal(report)) {
        setClassificationFeedback({
          message:
            "Pollution signal detected. Your report can appear on the public map while it waits for corroboration.",
          tone: "accepted",
        });
        return;
      }

      setClassificationFeedback({
        message:
          "No pollution signal detected in this photo. The report is saved for audit, but it will not appear on the public map.",
        tone: "neutral",
      });
    });
  }, [storedInFirebase, submissionId]);

  async function handlePhotoChange(file: File | undefined) {
    if (!file) return;
    setSubmitError("");
    setPhotoUrl("");
    setPhotoPreviewUrl("");
    setIsPreparingPhoto(true);

    try {
      const compressedPhoto = await compressPhotoForUpload(file);
      setPhotoPreviewUrl(compressedPhoto);
      const uploadedPhotoUrl = await uploadPhotoToImgBB(compressedPhoto, file.name);
      setPhotoUrl(uploadedPhotoUrl);
      setSubmitError("");
      setSubmitState("idle");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not prepare that image.");
      setSubmitState("error");
    } finally {
      setIsPreparingPhoto(false);
    }
  }

  function handleRemovePhoto() {
    setPhotoUrl("");
    setPhotoPreviewUrl("");
    setSubmitError("");
    setSubmitState("idle");
  }

  async function handleStartRecording() {
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Voice input is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks: BlobPart[] = [];

      const AudioContextCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const volumeData = new Uint8Array(analyser.frequencyBinCount);

      let silenceStartedAt: number | null = null;
      let animationFrame = 0;
      const recordingStartedAt = Date.now();
      let stopped = false;

      const stopEverything = () => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(animationFrame);
        if (recorder.state !== "inactive") recorder.stop();
        audioContext.close().catch(() => {});
      };

      const watchVolume = () => {
        analyser.getByteTimeDomainData(volumeData);
        let sumSquares = 0;
        for (const value of volumeData) {
          const normalized = value / 128 - 1;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / volumeData.length);
        const elapsed = Date.now() - recordingStartedAt;

        if (elapsed > SILENCE_GRACE_MS) {
          if (rms < SILENCE_VOLUME_THRESHOLD) {
            if (silenceStartedAt === null) silenceStartedAt = Date.now();
            else if (Date.now() - silenceStartedAt >= SILENCE_STOP_MS) {
              stopEverything();
              return;
            }
          } else {
            silenceStartedAt = null;
          }
        }

        animationFrame = requestAnimationFrame(watchVolume);
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = async () => {
        cancelAnimationFrame(animationFrame);
        stream.getTracks().forEach((track) => track.stop());
        const recordedSampleRate = audioContext.sampleRate;
        audioContext.close().catch(() => {});
        recordingCleanupRef.current = null;
        setIsRecording(false);
        setIsTranscribing(true);
        try {
          const blob = new Blob(chunks, { type: "audio/webm;codecs=opus" });
          const languageCode = SPEECH_LOCALE_MAP[locale] ?? "en-IN";
          const transcript = await transcribeAudio(blob, languageCode, recordedSampleRate);
          setNote((prev) => (prev ? `${prev} ${transcript}` : transcript));
        } catch (error) {
          setVoiceError(error instanceof Error ? error.message : "Could not transcribe that recording.");
        } finally {
          setIsTranscribing(false);
        }
      };

      recordingCleanupRef.current = stopEverything;
      recorder.start();
      animationFrame = requestAnimationFrame(watchVolume);
      setIsRecording(true);
    } catch {
      setVoiceError("Could not access the microphone. Check permissions and try again.");
    }
  }

  function handleStopRecording() {
    recordingCleanupRef.current?.();
  }

  useEffect(() => {
    return () => recordingCleanupRef.current?.();
  }, []);

  async function handleSubmit() {
    setSubmitState("submitting");
    setSubmitError("");
    setClassificationFeedback(null);

    if (isPreparingPhoto) {
      setSubmitError("Photo is still preparing. Try again in a moment.");
      setSubmitState("error");
      return;
    }

    if (!photoUrl) {
      setSubmitError("Attach a photo before submitting so Gemini can classify the report.");
      setSubmitState("error");
      return;
    }

    try {
      const submission = await submitCitizenReport({
        anonymous,
        aiConfidence: selectedHazard.confidence,
        hazardId: selectedHazard.id,
        hazardLabel: selectedHazard.label,
        location,
        note,
        photoUrl,
        result: selectedHazard.result,
      });

      setSubmissionId(submission.id);
      setStoredInFirebase(submission.stored);
      if (submission.stored) {
        setClassificationFeedback({
          message: "Analyzing your photo...",
          tone: "processing",
        });
      }
      setSubmitState("submitted");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unknown Firebase error");
      setSubmitState("error");
    }
  }

  /* ── Steps data for the sidebar ───────────────────────────────────── */
  const pipelineSteps = [
    { label: t("report_what_happens_step3"), description: "AI validates visual evidence" },
    { label: t("report_what_happens_step2"), description: "Cross-referenced with sensors" },
    { label: t("report_what_happens_step4"), description: "Flagged for municipal action" },
  ];

  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>

      <div className="app-page-container app-page-content rp-page">

        {/* ── Page header ─────────────────────────────────────────────── */}
        <header className="rp-header">
          <div className="rp-header-left">
            <span className="rp-kicker">{t("report_eyebrow")}</span>
            <h1 className="rp-title">{t("report_title")}</h1>
            <p className="rp-subtitle">{t("report_description")}</p>
          </div>
        </header>

        {/* ── Two-column layout ───────────────────────────────────────── */}
        <section className="rp-layout">

          {/* ── Left: Form ───────────────────────────────────────────── */}
          <form
            className="rp-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >

            {/* Upload zone */}
            <div className="rp-section">
              <label className="rp-section-label">
                <span className="rp-section-number">01</span>
                {t("report_form_upload_photo")}
              </label>
              <div className={photoPreviewUrl ? "rp-upload has-photo" : "rp-upload"}>
                <input
                  id="pollution-photo"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => handlePhotoChange(event.target.files?.[0])}
                />
                {!photoPreviewUrl ? (
                  <label htmlFor="pollution-photo" className="rp-upload-label">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="rp-upload-icon">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                      <circle cx="12" cy="13" r="4"/>
                    </svg>
                    <strong>
                      {isPreparingPhoto ? "Uploading photo..." : t("report_form_open_camera")}
                    </strong>
                    <span>{t("report_form_what_seeing_hint")}</span>
                  </label>
                ) : (
                  <div className="rp-evidence">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Local data URL preview before the image is hosted. */}
                    <img alt="Uploaded pollution report evidence" src={photoPreviewUrl} />
                    <div className="rp-evidence-info">
                      <span className={photoUrl ? "rp-status-pill ready" : "rp-status-pill uploading"}>
                        {photoUrl ? "✓ Ready" : "Uploading..."}
                      </span>
                      <strong>{photoUrl ? "Photo uploaded" : "Please wait..."}</strong>
                      <small>{t("report_what_happens_step1")}</small>
                      <div className="rp-evidence-actions">
                        <label htmlFor="pollution-photo">{t("report_form_change_photo")}</label>
                        <button onClick={handleRemovePhoto} type="button">Remove</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Hazard type */}
            <div className="rp-section">
              <label className="rp-section-label">
                <span className="rp-section-number">02</span>
                {t("report_form_what_seeing")}
              </label>
              <div className="rp-tag-grid">
                {hazardTags.map((tag) => (
                  <button
                    aria-pressed={tag.id === selectedTag}
                    className={tag.id === selectedTag ? "rp-tag active" : "rp-tag"}
                    key={tag.id}
                    onClick={() => setSelectedTag(tag.id)}
                    type="button"
                  >
                    <strong>{t(tag.label)}</strong>
                    <span>{t(tag.description)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Location */}
            <div className="rp-section">
              <label className="rp-section-label">
                <span className="rp-section-number">03</span>
                Location
              </label>
              <ReportLocationPicker value={location} onChange={setLocation} />
            </div>

            {/* Note / voice */}
            <div className="rp-section">
              <label className="rp-section-label">
                <span className="rp-section-number">04</span>
                {t("report_form_note_label")}
              </label>
              <div className="rp-note-wrap">
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t("report_form_hint_example")}
                  rows={3}
                />
                <div className="rp-note-toolbar">
                  <button
                    className={isRecording ? "rp-voice-btn recording" : "rp-voice-btn"}
                    disabled={isTranscribing}
                    onClick={isRecording ? handleStopRecording : handleStartRecording}
                    type="button"
                  >
                    {isRecording ? (
                      <>
                        <span className="voice-input-dot" aria-hidden="true" />
                        Listening…
                      </>
                    ) : isTranscribing ? (
                      <>
                        <span className="voice-input-spinner" aria-hidden="true" />
                        Transcribing…
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                          <path
                            fill="currentColor"
                            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
                          />
                        </svg>
                        Speak
                      </>
                    )}
                  </button>
                </div>
                {isRecording && (
                  <small className="voice-input-hint">Stops automatically when you pause.</small>
                )}
                {voiceError && <small className="voice-input-error">{voiceError}</small>}
              </div>
            </div>

            {/* Anonymous + submit */}
            <div className="rp-footer">
              <label className="rp-anon-toggle">
                <input
                  checked={anonymous}
                  onChange={(event) => setAnonymous(event.target.checked)}
                  type="checkbox"
                />
                {t("report_form_submit_anonymous")}
              </label>

              <button
                className="rp-submit-btn"
                disabled={submitState === "submitting" || isPreparingPhoto}
                type="submit"
              >
                {isPreparingPhoto
                  ? "Uploading photo..."
                  : submitState === "submitting"
                    ? t("report_form_submitting")
                    : t("report_form_submit_button")}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </form>

          {/* ── Right: Sidebar ───────────────────────────────────────── */}
          <aside className="rp-sidebar">

            {/* Pipeline steps */}
            <div className="rp-pipeline-card">
              <h2>{t("report_what_happens_title")}</h2>
              <div className="rp-pipeline-steps">
                {pipelineSteps.map((step, i) => (
                  <div className="rp-step" key={i}>
                    <div className="rp-step-icon">
                      <StepIcon step={i} />
                    </div>
                    <div className="rp-step-text">
                      <span>{step.label}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Submission result */}
            {submitState === "submitted" && (
              <div
                className={
                  isNoSignalFeedback
                    ? "rp-result-card neutral"
                    : "rp-result-card success"
                }
                role="status"
              >
                <div className="rp-result-header">
                  <div className={isNoSignalFeedback ? "rp-result-dot neutral" : isProcessingFeedback ? "rp-result-dot processing" : "rp-result-dot success"} />
                  <strong>
                    {isNoSignalFeedback
                      ? "Report checked"
                      : isProcessingFeedback
                        ? "Analyzing report"
                      : storedInFirebase
                        ? "Report saved"
                        : "Report submitted"}
                  </strong>
                </div>
                <p>
                  {isNoSignalFeedback
                    ? "The report remains saved for audit, but it will stay out of the public hotspot layer."
                    : isProcessingFeedback
                      ? "The system is checking whether the image shows smoke, dust, haze, or fire."
                    : `Your report helped flag a possible hotspot near ${location.label}. Municipal teams will see it in the incident queue after validation.`}
                </p>
                {submissionId && <small className="rp-result-id">ID: {submissionId}</small>}
                {classificationFeedback && (
                  <small className={`classification-feedback ${classificationFeedback.tone}`}>
                    {classificationFeedback.tone === "processing" && (
                      <span className="classification-spinner" aria-hidden="true" />
                    )}
                    {classificationFeedback.message}
                  </small>
                )}
                <Link href="/map" className="rp-result-link">{t("report_form_see_nearby")} →</Link>
              </div>
            )}

            {submitState === "error" && (
              <div className="rp-result-card error" role="alert">
                <div className="rp-result-header">
                  <div className="rp-result-dot error" />
                  <strong>
                    {photoUrl ? "Could not save report" : "Photo needed"}
                  </strong>
                </div>
                <p>
                  {photoUrl
                    ? "Check Firestore setup and security rules, then try submitting again."
                    : "Attach a photo so Gemini can classify the report before validation."}
                </p>
                {submitError && <small>{submitError}</small>}
              </div>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
