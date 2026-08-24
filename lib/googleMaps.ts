export type GoogleMapSize = unknown;
export type GoogleMapPoint = unknown;

export interface GoogleMapLatLng {
  lat: () => number;
  lng: () => number;
}

export interface GoogleMapMarker {
  addListener: (eventName: string, handler: () => void) => void;
  getPosition?: () => GoogleMapLatLng | undefined;
  setAnimation: (animation: unknown) => void;
  setMap: (map: GoogleMapInstance | null) => void;
  setPosition?: (position: { lat: number; lng: number }) => void;
}

export interface GoogleMapCircle {
  setMap: (map: GoogleMapInstance | null) => void;
}

export interface GoogleMapInstance {
  panTo: (position: { lat: number; lng: number }) => void;
  setCenter?: (position: { lat: number; lng: number }) => void;
  setZoom?: (zoom: number) => void;
}

export interface GoogleMapInfoWindow {
  open: (options: { anchor?: GoogleMapMarker; map: GoogleMapInstance }) => void;
  setContent: (content: string) => void;
}

export interface GoogleMapGeocoderResult {
  formatted_address?: string;
  name?: string;
}

export interface GoogleMapGeocoder {
  geocode: (
    request: Record<string, unknown>,
    callback: (
      results: GoogleMapGeocoderResult[] | null,
      status: string,
    ) => void,
  ) => void;
}

export interface GooglePlaceResult {
  formatted_address?: string;
  geometry?: {
    location?: GoogleMapLatLng;
  };
  name?: string;
}

export interface GooglePlaceAutocomplete {
  addListener: (eventName: string, handler: () => void) => void;
  getPlace: () => GooglePlaceResult;
}

export interface GoogleMapsApi {
  maps: {
    Animation: {
      BOUNCE: unknown;
    };
    Circle: new (options: Record<string, unknown>) => GoogleMapCircle;
    ControlPosition: {
      RIGHT_BOTTOM: unknown;
      TOP_RIGHT: unknown;
    };
    event: {
      clearInstanceListeners: (instance: unknown) => void;
      trigger: (instance: unknown, eventName: string) => void;
    };
    Geocoder: new () => GoogleMapGeocoder;
    InfoWindow: new (options?: Record<string, unknown>) => GoogleMapInfoWindow;
    Map: new (node: HTMLElement, options: Record<string, unknown>) => GoogleMapInstance;
    Marker: new (options: Record<string, unknown>) => GoogleMapMarker;
    Point: new (x: number, y: number) => GoogleMapPoint;
    places?: {
      Autocomplete: new (
        input: HTMLInputElement,
        options: Record<string, unknown>,
      ) => GooglePlaceAutocomplete;
    };
    Size: new (width: number, height: number) => GoogleMapSize;
    importLibrary?: (name: string) => Promise<unknown>;
  };
}

export type GoogleMapsWindow = typeof window & {
  cleanAirGoogleMapsPromises?: Partial<Record<string, Promise<void>>>;
  google?: GoogleMapsApi;
  _cleanAirConsolePatched?: boolean;
};

const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 12_000;

export function getGoogleMapsWindow(): GoogleMapsWindow {
  const win = window as GoogleMapsWindow;
  if (!win._cleanAirConsolePatched) {
    win._cleanAirConsolePatched = true;
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === "string" && args[0].includes("google.maps.places.Autocomplete is not available to new customers")) return;
      if (typeof args[0] === "string" && args[0].includes("As of March 1st, 2025")) return;
      if (typeof args[0] === "string" && args[0].includes("google.maps.Marker is deprecated")) return;
      originalWarn.apply(console, args);
    };
  }
  return win;
}

export function getGoogleMaps() {
  return getGoogleMapsWindow().google;
}

export function loadGoogleMaps(apiKey: string, options: { places?: boolean } = {}) {
  const mapsWindow = getGoogleMapsWindow();
  const needsPlaces = options.places ?? false;
  if (mapsWindow.google?.maps && (!needsPlaces || mapsWindow.google.maps.places)) {
    return Promise.resolve();
  }
  if (mapsWindow.google?.maps?.importLibrary && needsPlaces) {
    return mapsWindow.google.maps.importLibrary("places").then(() => undefined);
  }

  const promiseKey = needsPlaces ? "places" : "core";
  mapsWindow.cleanAirGoogleMapsPromises ??= {};
  if (mapsWindow.cleanAirGoogleMapsPromises[promiseKey]) {
    return mapsWindow.cleanAirGoogleMapsPromises[promiseKey];
  }

  mapsWindow.cleanAirGoogleMapsPromises[promiseKey] = new Promise((resolve, reject) => {
    const callbackName = `initMap_${promiseKey}_${Math.round(Math.random() * 1000000)}`;
    let settled = false;
    let timeoutId: number | undefined;
    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      delete (mapsWindow as any)[callbackName];
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      delete mapsWindow.cleanAirGoogleMapsPromises?.[promiseKey];
      reject(error);
    };

    (mapsWindow as any)[callbackName] = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
      callback: callbackName,
    });
    if (needsPlaces) params.set("libraries", "places");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => fail(new Error("Google Maps failed to load."));
    timeoutId = window.setTimeout(() => {
      fail(new Error("Google Maps timed out while loading."));
    }, GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    document.head.appendChild(script);
  });

  return mapsWindow.cleanAirGoogleMapsPromises[promiseKey];
}
