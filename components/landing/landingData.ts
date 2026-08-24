// Note: this file previously exported mock-incident-derived stats
// (activeIncidents, criticalIncidents, priorityIncidents, heroStats,
// highestForecast) built from lib/mockData.ts. Nothing actually consumed
// them — HeroSection.tsx computes its own live versions straight from
// Firestore — so they've been removed rather than wired to real data.

export const workflowSteps = [
  {
    step: "01",
    title: "Citizen evidence",
    text: "Residents submit smoke, dust, or burning-waste reports with photo and location context.",
  },
  {
    step: "02",
    title: "AI validation",
    text: "Gemini checks visual signals while sensors, satellite context, and nearby reports raise confidence.",
  },
  {
    step: "03",
    title: "Targeted response",
    text: "Officials receive a ranked incident queue with suggested crews, mist cannons, and cleanup actions.",
  },
];

export const techStack = [
  "Gemini multimodal",
  "Google Maps",
  "Earth Engine",
  "Firebase",
  "BigQuery",
  "Vertex AI",
];
