// The citizen's hazard selection is context for Gemini and the operator —
// not a confidence score. Confidence only ever comes from Gemini's
// classification of the actual photo (see /api/classify-report).
export const hazardTags = [
  {
    id: "garbage-fire",
    label: "hazard_garbage_fire_label",
    description: "hazard_garbage_fire_desc",
    result: "Likely garbage fire",
  },
  {
    id: "traffic-smog",
    label: "hazard_traffic_smog_label",
    description: "hazard_traffic_smog_desc",
    result: "Likely traffic smog trap",
  },
  {
    id: "construction-dust",
    label: "hazard_construction_dust_label",
    description: "hazard_construction_dust_desc",
    result: "Likely construction dust",
  },
  {
    id: "industrial-emission",
    label: "hazard_industrial_emission_label",
    description: "hazard_industrial_emission_desc",
    result: "Likely industrial emission",
  },
];

// No coordinates until the reporter sets them. A pre-filled point would put
// every un-located report in the same H3 cell, where three of them would
// "corroborate" each other into a false crowd-verified incident.
export const defaultLocation = {
  label: "",
  lat: "",
  lng: "",
};
