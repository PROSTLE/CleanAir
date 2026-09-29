// Recurring emission sources used for upwind attribution. They are read from
// OpenStreetMap for every city (lib/server/osmPlaces.ts); none are typed in.
export type KnownSourceKind = "landfill" | "industrial_area" | "traffic_hub";

export type KnownSource = {
  name: string;
  kind: KnownSourceKind;
  lat: number;
  lng: number;
};
