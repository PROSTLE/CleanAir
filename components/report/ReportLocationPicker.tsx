"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGoogleMaps,
  loadGoogleMaps,
  type GoogleMapInstance,
  type GoogleMapMarker,
} from "@/lib/googleMaps";
import type { CityConfig } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";
import { toCoordinate } from "@/lib/geo";
import { useT } from "@/lib/languageContext";

export interface ReportLocationValue {
  label: string;
  lat: string;
  lng: string;
}

interface ReportLocationPickerProps {
  onChange: (location: ReportLocationValue) => void;
  value: ReportLocationValue;
}

type PickerStatus = "idle" | "ready" | "error";
type Suggestion = { placeId: string; text: string };

const SEARCH_DEBOUNCE_MS = 250;
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

const pickerMapStyles = [
  {
    featureType: "poi.business",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#d8e1da" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#d9ece7" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#eef4f1" }],
  },
];

function toPosition(location: ReportLocationValue, city: CityConfig) {
  // Blank means "not set yet": open on the selected city, not on (0, 0).
  const lat = toCoordinate(location.lat);
  const lng = toCoordinate(location.lng);

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  return city.center;
}

function formatCoordinate(value: number) {
  return value.toFixed(6);
}

function newSessionToken() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Search and reverse geocoding run through /api/places (Places API (New) on
// the server). Google retired the browser Autocomplete widget for new
// projects, and the server route keeps that key out of the page.
async function reverseGeocode(position: { lat: number; lng: number }) {
  const fallback = `${formatCoordinate(position.lat)}, ${formatCoordinate(position.lng)}`;
  try {
    const response = await fetch(`/api/places?lat=${position.lat}&lng=${position.lng}`);
    const data = (await response.json()) as { label?: string | null };
    return response.ok && data.label ? data.label : fallback;
  } catch {
    return fallback;
  }
}

export default function ReportLocationPicker({
  onChange,
  value,
}: ReportLocationPickerProps) {
  const t = useT();
  const { city } = useCity();
  const cityRef = useRef(city);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markerRef = useRef<GoogleMapMarker | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const sessionRef = useRef<string>(newSessionToken());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const [mapEnabled, setMapEnabled] = useState(false);
  const [mapStatus, setMapStatus] = useState<PickerStatus>("idle");
  const [helperText, setHelperText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const status: PickerStatus = MAPS_KEY ? mapStatus : "error";

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
    cityRef.current = city;
  }, [city, onChange, value]);

  // Switching city recentres an open map picker that has no pin yet.
  useEffect(() => {
    if (!Number.isFinite(toCoordinate(valueRef.current.lat))) {
      mapRef.current?.panTo(city.center);
      markerRef.current?.setPosition?.(city.center);
    }
  }, [city]);

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  const commitLocation = useCallback((
    position: { lat: number; lng: number },
    label: string,
    zoom = 15,
  ) => {
    const nextLocation = {
      label,
      lat: formatCoordinate(position.lat),
      lng: formatCoordinate(position.lng),
    };

    onChangeRef.current(nextLocation);
    mapRef.current?.panTo(position);
    mapRef.current?.setZoom?.(zoom);
    markerRef.current?.setPosition?.(position);
    setHelperText(`Selected ${nextLocation.lat}, ${nextLocation.lng}`);
  }, []);

  const commitLocationWithReverseGeocode = useCallback(async (
    position: { lat: number; lng: number },
  ) => {
    commitLocation(position, await reverseGeocode(position));
  }, [commitLocation]);

  function handleDetectLocation() {
    if (!navigator.geolocation) {
      setHelperText("Location detection is not available in this browser.");
      return;
    }

    setHelperText("Detecting your location...");
    navigator.geolocation.getCurrentPosition(
      (result) => {
        void commitLocationWithReverseGeocode({
          lat: result.coords.latitude,
          lng: result.coords.longitude,
        });
      },
      () => {
        setHelperText("Could not detect location. Search a nearby place instead.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30_000,
        timeout: 10_000,
      },
    );
  }

  function handleInput(text: string) {
    // Free text alone has no coordinates. Clear the previous pin so a typed
    // "Rohini" can't be saved at the old location's lat/lng; picking a
    // suggestion, detecting, or dropping a pin sets them.
    onChange({ label: text, lat: "", lng: "" });
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const query = text.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    const seq = ++searchSeqRef.current;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, city: cityRef.current.id, session: sessionRef.current });
        const response = await fetch(`/api/places?${params}`);
        const data = (await response.json()) as { suggestions?: Suggestion[]; error?: string };
        if (seq !== searchSeqRef.current) return; // a newer keystroke won
        if (!response.ok) {
          setSuggestions([]);
          setHelperText("Place search is unavailable. Use GPS or the map picker.");
          return;
        }
        setSuggestions(data.suggestions ?? []);
        setActiveIndex(-1);
        if (!data.suggestions?.length) setHelperText("No matching places in this city. Try another name or drop a pin.");
      } catch {
        if (seq === searchSeqRef.current) setSuggestions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  async function selectSuggestion(suggestion: Suggestion) {
    setSuggestions([]);
    setActiveIndex(-1);
    searchSeqRef.current += 1;
    setHelperText("Locating place...");
    try {
      const params = new URLSearchParams({ placeId: suggestion.placeId, session: sessionRef.current });
      const response = await fetch(`/api/places?${params}`);
      const data = (await response.json()) as { lat?: number; lng?: number; label?: string; error?: string };
      if (!response.ok || typeof data.lat !== "number" || typeof data.lng !== "number") {
        throw new Error(data.error ?? "No location for that place.");
      }
      commitLocation({ lat: data.lat, lng: data.lng }, data.label || suggestion.text);
    } catch {
      setHelperText("Could not locate that place. Try another result or drop a pin.");
    } finally {
      // A new search session starts after every selection.
      sessionRef.current = newSessionToken();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      void selectSuggestion(suggestions[activeIndex]);
    } else if (event.key === "Escape") {
      setSuggestions([]);
    }
  }

  useEffect(() => {
    if (!mapEnabled || !mapNodeRef.current || !MAPS_KEY) return;

    let cancelled = false;

    loadGoogleMaps(MAPS_KEY)
      .then(() => {
        if (cancelled || !mapNodeRef.current) return;

        const maps = getGoogleMaps()?.maps;
        if (!maps) throw new Error("Google Maps did not load.");

        const startPosition = toPosition(valueRef.current, cityRef.current);
        const map = new maps.Map(mapNodeRef.current, {
          center: startPosition,
          clickableIcons: false,
          controlSize: 24,
          disableDefaultUI: true,
          gestureHandling: "cooperative",
          mapTypeControl: false,
          streetViewControl: false,
          styles: pickerMapStyles,
          zoom: 14,
          zoomControl: true,
        });

        const marker = new maps.Marker({
          draggable: true,
          map,
          position: startPosition,
          title: "Drag to fine-tune report location",
        });

        marker.addListener("dragend", () => {
          const markerPosition = marker.getPosition?.();
          if (!markerPosition) return;

          void commitLocationWithReverseGeocode({
            lat: markerPosition.lat(),
            lng: markerPosition.lng(),
          });
        });

        mapRef.current = map;
        markerRef.current = marker;
        setMapStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setMapStatus("error");
          setHelperText("Map picker unavailable. Use search or GPS instead.");
        }
      });

    return () => {
      cancelled = true;
      const maps = getGoogleMaps()?.maps;
      if (markerRef.current) {
        maps?.event.clearInstanceListeners(markerRef.current);
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
      mapRef.current = null;
    };
  }, [mapEnabled, commitLocationWithReverseGeocode]);

  const listboxId = "report-location-suggestions";

  return (
    <div className="location-picker-card">
      <div className="location-picker-row">
        <label htmlFor="report-location">{t("location_picker_label")}</label>
        <div className="location-picker-actions">
          <button type="button" onClick={handleDetectLocation}>
            {t("location_picker_detect")}
          </button>
          <button
            aria-pressed={mapEnabled}
            type="button"
            onClick={() => setMapEnabled(true)}
          >
            {t("location_picker_map")}
          </button>
        </div>
      </div>

      <div className="location-picker-search">
        <input
          value={value.label}
          id="report-location"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          autoComplete="off"
          onChange={(event) => handleInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => window.setTimeout(() => setSuggestions([]), 150)}
          placeholder={t("location_picker_search")}
        />
        {suggestions.length > 0 && (
          <ul className="location-picker-suggestions" id={listboxId} role="listbox">
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.placeId}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "is-active" : ""}
                // mousedown fires before the input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  void selectSuggestion(suggestion);
                }}
              >
                {suggestion.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      {mapEnabled && (
        <div className="location-picker-map">
          <div className="location-picker-canvas" ref={mapNodeRef} />
          {status !== "ready" && (
            <div className="location-picker-state">
              <strong>{status === "error" ? "Map unavailable" : "Loading map picker"}</strong>
              <span>
                {status === "error"
                  ? "Search or GPS still set the location."
                  : "Preparing draggable report pin."}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="location-picker-meta">
        <small aria-live="polite">
          {helperText || t("report_form_use_gps")}
        </small>
        <span>
          {value.lat && value.lng
            ? `${value.lat.toString().substring(0, 9)}, ${value.lng.toString().substring(0, 9)}`
            : "No location set"}
        </span>
      </div>
    </div>
  );
}
