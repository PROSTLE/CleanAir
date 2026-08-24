"""
Prep Delhi historical CPCB air quality data for BigQuery.

Since stations.csv in this Kaggle dataset does NOT include lat/lng,
we use a manually-verified coordinate mapping (delhi_station_coords.py)
for the 38 Delhi stations (DL001-DL038) instead.

INPUT FILES NEEDED (same folder as this script):
   - station_hour.csv   (from Kaggle: rohanrao/air-quality-data-in-india)
   - delhi_station_coords.py  (already provided)

RUN:
   cd ml
   python3 prep_delhi_data.py

OUTPUT:
   delhi_historical_snapshots.csv
"""

import pandas as pd
import h3
from delhi_station_coords import DELHI_STATION_COORDS

STATION_READINGS_FILE = "station_hour.csv"
OUTPUT_FILE = "delhi_historical_snapshots.csv"
H3_RESOLUTION = 8


def main():
    print("Loading pollution readings...")
    readings = pd.read_csv(STATION_READINGS_FILE)
    readings.columns = [c.strip() for c in readings.columns]

    delhi_ids = set(DELHI_STATION_COORDS.keys())
    readings = readings[readings["StationId"].isin(delhi_ids)].copy()
    print(f"Filtered to {len(readings):,} Delhi readings across {readings['StationId'].nunique()} stations.")

    if readings.empty:
        raise ValueError(
            "No rows matched Delhi station IDs. Check that station_hour.csv "
            "actually contains StationId values like 'DL001', 'DL014', etc."
        )

    readings["Latitude"] = readings["StationId"].map(lambda sid: DELHI_STATION_COORDS[sid]["lat"])
    readings["Longitude"] = readings["StationId"].map(lambda sid: DELHI_STATION_COORDS[sid]["lng"])
    readings["StationName"] = readings["StationId"].map(lambda sid: DELHI_STATION_COORDS[sid]["name"])

    print(f"Assigning H3 cell IDs at resolution {H3_RESOLUTION}...")
    readings["h3CellId"] = readings.apply(
        lambda row: h3.latlng_to_cell(row["Latitude"], row["Longitude"], H3_RESOLUTION),
        axis=1,
    )

    datetime_col = "Datetime" if "Datetime" in readings.columns else "Date"

    out = pd.DataFrame({
        "sampledAt": pd.to_datetime(readings[datetime_col]),
        "h3CellId": readings["h3CellId"],
        "location.label": readings["StationName"],
        "location.lat": readings["Latitude"],
        "location.lng": readings["Longitude"],
        "sensor.pm25": readings.get("PM2.5"),
        "sensor.pm10": readings.get("PM10"),
        "sensor.no2": readings.get("NO2"),
        "sensor.so2": readings.get("SO2"),
        "sensor.co": readings.get("CO"),
        "sensor.nh3": readings.get("NH3"),
        "sensor.ozone": readings.get("O3"),
        "sourceContext": "historical_cpcb_kaggle",
    })

    before = len(out)
    out = out.dropna(subset=["sensor.pm25", "sensor.pm10"], how="all")
    print(f"Dropped {before - len(out)} rows with no PM2.5/PM10 data.")

    out = out.sort_values("sampledAt")
    out.to_csv(OUTPUT_FILE, index=False)

    print(f"\nDone. Wrote {len(out):,} rows to {OUTPUT_FILE}")
    print(f"Unique H3 cells: {out['h3CellId'].nunique()}")
    print(f"Date range: {out['sampledAt'].min()} to {out['sampledAt'].max()}")


if __name__ == "__main__":
    main()