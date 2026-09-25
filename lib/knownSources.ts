// Recurring Delhi emission sources used for upwind attribution. Coordinates
// are the approximate area centroids already used elsewhere in this repo
// (lib/ambientScan.ts MONITORED_CELLS, lib/forecastEngine.ts cells); they are
// good to ~1 km, which is the scale attribution works at.
export type KnownSourceKind = "landfill" | "industrial_area" | "traffic_hub";

export type KnownSource = {
  name: string;
  kind: KnownSourceKind;
  lat: number;
  lng: number;
};

export const KNOWN_SOURCES: KnownSource[] = [
  { name: "Ghazipur Landfill", kind: "landfill", lat: 28.6264, lng: 77.3192 },
  { name: "Bhalswa Landfill", kind: "landfill", lat: 28.7427, lng: 77.1636 },
  { name: "Wazirpur Industrial Area", kind: "industrial_area", lat: 28.7041, lng: 77.1653 },
  { name: "Mundka Industrial Area", kind: "industrial_area", lat: 28.6822, lng: 77.031 },
  { name: "Okhla Industrial Area", kind: "industrial_area", lat: 28.5355, lng: 77.291 },
  { name: "Naraina Industrial Area", kind: "industrial_area", lat: 28.6285, lng: 77.1409 },
  { name: "Bawana Industrial Area", kind: "industrial_area", lat: 28.8039, lng: 77.0469 },
  { name: "Anand Vihar ISBT", kind: "traffic_hub", lat: 28.6469, lng: 77.3152 },
  { name: "ITO Crossing", kind: "traffic_hub", lat: 28.6292, lng: 77.241 },
];
