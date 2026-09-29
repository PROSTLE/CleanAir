// The public ground-station feeds a reading can come from. Shared by server
// and client code, so it holds no server-only imports.
export type StationFeed = "CPCB" | "WAQI" | "OpenAQ";

export function isStationFeed(source: unknown): source is StationFeed {
  return source === "CPCB" || source === "WAQI" || source === "OpenAQ";
}
