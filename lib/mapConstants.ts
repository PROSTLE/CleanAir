// Known Delhi pollution-prone zones watched by the ambient scan
// (lib/ambientScan.ts). These are area centroids, good to roughly 1 km —
// the scale of an H3 res-8 cell — not the position of any single sensor.
export const MONITORED_CELLS: Array<{ label: string; lat: number; lng: number }> = [
  { label: "Anand Vihar", lat: 28.6469, lng: 77.3152 },
  { label: "Wazirpur Industrial Area", lat: 28.7041, lng: 77.1653 },
  { label: "ITO Crossing", lat: 28.6292, lng: 77.241 },
  { label: "Mundka", lat: 28.6822, lng: 77.031 },
  { label: "Okhla Industrial Area", lat: 28.5355, lng: 77.291 },
  { label: "RK Puram", lat: 28.5651, lng: 77.1815 },
  { label: "Rohini", lat: 28.7346, lng: 77.1177 },
  { label: "Naraina Industrial Area", lat: 28.6285, lng: 77.1409 },
  { label: "Ghazipur Landfill", lat: 28.6264, lng: 77.3192 },
  { label: "Bawana Industrial Area", lat: 28.8039, lng: 77.0469 },
];
