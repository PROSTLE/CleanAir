"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGoogleMaps,
  loadGoogleMaps,
  type GoogleMapGeocoder,
  type GoogleMapInstance,
  type GoogleMapMarker,
  type GooglePlaceAutocomplete,
} from "@/lib/googleMaps";
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

type PickerStatus = "idle" | "loading" | "ready" | "error";

const DELHI_CENTER = { lat: 28.6139, lng: 77.209 };

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

function toPosition(location: ReportLocationValue) {
  const lat = Number(location.lat);
  const lng = Number(location.lng);

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  return DELHI_CENTER;
}

function formatCoordinate(value: number) {
  return value.toFixed(6);
}

function reverseGeocode(
  geocoder: GoogleMapGeocoder,
  position: { lat: number; lng: number },
) {
  return new Promise<string>((resolve) => {
    geocoder.geocode({ location: position }, (results, status) => {
      if (status === "OK" && results?.[0]?.formatted_address) {
        resolve(results[0].formatted_address);
        return;
      }

      resolve(`${formatCoordinate(position.lat)}, ${formatCoordinate(position.lng)}`);
    });
  });
}

export default function ReportLocationPicker({
  onChange,
  value,
}: ReportLocationPickerProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markerRef = useRef<GoogleMapMarker | null>(null);
  const geocoderRef = useRef<GoogleMapGeocoder | null>(null);
  const autocompleteRef = useRef<GooglePlaceAutocomplete | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const [mapEnabled, setMapEnabled] = useState(false);
  const [status, setStatus] = useState<PickerStatus>("idle");
  const [helperText, setHelperText] = useState("");

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  }, [onChange, value]);

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
    const geocoder = geocoderRef.current;
    const label = geocoder
      ? await reverseGeocode(geocoder, position)
      : `${formatCoordinate(position.lat)}, ${formatCoordinate(position.lng)}`;

    commitLocation(position, label);
  }, [commitLocation]);

  async function handleDetectLocation() {
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

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey || !inputRef.current) {
      setStatus(apiKey ? "idle" : "error");
      return;
    }

    let cancelled = false;

    loadGoogleMaps(apiKey, { places: true })
      .then(() => {
        if (cancelled || !inputRef.current) return;

        const google = getGoogleMaps();
        const maps = google?.maps;
        if (!maps?.places) throw new Error("Google Places library is not available.");

        if (!autocompleteRef.current) {
          const geocoder = new maps.Geocoder();
          const autocomplete = new maps.places.Autocomplete(inputRef.current, {
            componentRestrictions: { country: "in" },
            fields: ["formatted_address", "geometry", "name"],
          });

          autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            const placePosition = place.geometry?.location;
            if (!placePosition) {
              setHelperText("Select a place from the dropdown so coordinates can update.");
              return;
            }

            commitLocation(
              {
                lat: placePosition.lat(),
                lng: placePosition.lng(),
              },
              place.formatted_address ?? place.name ?? valueRef.current.label,
            );
          });

          geocoderRef.current = geocoder;
          autocompleteRef.current = autocomplete;
        }

        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setHelperText("Map picker unavailable. Check the Maps JavaScript API key.");
        }
      });

    return () => {
      cancelled = true;
      const maps = getGoogleMaps()?.maps;
      if (autocompleteRef.current) {
        maps?.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };
  }, [commitLocation]);

  useEffect(() => {
    if (!mapEnabled || !mapNodeRef.current) return;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return;

    let cancelled = false;

    loadGoogleMaps(apiKey, { places: true })
      .then(() => {
        if (cancelled || !mapNodeRef.current) return;

        const google = getGoogleMaps();
        const maps = google?.maps;
        if (!maps) return;

        const startPosition = toPosition(valueRef.current);
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
      })
      .catch(() => {
        // Handled by the main effect
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

  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value.label) {
      inputRef.current.value = value.label;
    }
  }, [value.label]);

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

      <input
        value={value.label === "default_location_label" ? t("default_location_label") : value.label}
        id="report-location"
        onChange={(event) =>
          onChange({
            ...value,
            label: event.target.value,
          })
        }
        placeholder={t("location_picker_search")}
        ref={inputRef}
      />

      {mapEnabled && (
        <div className="location-picker-map">
          <div className="location-picker-canvas" ref={mapNodeRef} />
          {status !== "ready" && (
            <div className="location-picker-state">
              <strong>{status === "error" ? "Map unavailable" : "Loading map picker"}</strong>
              <span>
                {status === "error"
                  ? "Location can still be set after the API key is fixed."
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
          {value.lat.toString().substring(0, 9)}, {value.lng.toString().substring(0, 9)}
        </span>
      </div>
    </div>
  );
}
