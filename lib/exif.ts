// Minimal JPEG EXIF reader: DateTimeOriginal and GPS position only. Runs on
// the original file before canvas compression strips metadata. Used purely as
// an integrity *flag* (old photo / taken far away) — a missing or odd EXIF
// never blocks a report, since many phones and apps strip it.

export type PhotoMeta = {
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
};

const EMPTY: PhotoMeta = { takenAt: null, lat: null, lng: null };

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG = 0x0004;

type Entry = { type: number; count: number; valueOffset: number; entryOffset: number };

function readIfd(view: DataView, tiffStart: number, ifdOffset: number, little: boolean) {
  const entries = new Map<number, Entry>();
  const base = tiffStart + ifdOffset;
  if (base + 2 > view.byteLength) return entries;
  const count = view.getUint16(base, little);
  for (let i = 0; i < count; i += 1) {
    const entryOffset = base + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    entries.set(view.getUint16(entryOffset, little), {
      type: view.getUint16(entryOffset + 2, little),
      count: view.getUint32(entryOffset + 4, little),
      valueOffset: view.getUint32(entryOffset + 8, little),
      entryOffset,
    });
  }
  return entries;
}

function readAscii(view: DataView, tiffStart: number, entry: Entry) {
  // Values of 4 bytes or fewer are stored inline in the entry.
  const start = entry.count <= 4 ? entry.entryOffset + 8 : tiffStart + entry.valueOffset;
  let text = "";
  for (let i = 0; i < entry.count && start + i < view.byteLength; i += 1) {
    const code = view.getUint8(start + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

function readRationals(view: DataView, tiffStart: number, entry: Entry, little: boolean) {
  const values: number[] = [];
  const start = tiffStart + entry.valueOffset;
  for (let i = 0; i < entry.count; i += 1) {
    const offset = start + i * 8;
    if (offset + 8 > view.byteLength) break;
    const numerator = view.getUint32(offset, little);
    const denominator = view.getUint32(offset + 4, little);
    values.push(denominator === 0 ? NaN : numerator / denominator);
  }
  return values;
}

function toDecimalDegrees(parts: number[], ref: string) {
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return ref === "S" || ref === "W" ? -value : value;
}

/** "YYYY:MM:DD HH:MM:SS" in the camera's local clock → ISO (browser tz). */
function parseExifDate(value: string) {
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseExif(buffer: ArrayBuffer): PhotoMeta {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return EMPTY;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return EMPTY;
    const length = view.getUint16(offset + 2);
    // APP1 segment beginning with "Exif\0\0".
    if (
      marker === 0xffe1 &&
      offset + 10 <= view.byteLength &&
      view.getUint32(offset + 4) === 0x45786966 &&
      view.getUint16(offset + 8) === 0
    ) {
      const tiffStart = offset + 10;
      const byteOrder = view.getUint16(tiffStart);
      if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return EMPTY;
      const little = byteOrder === 0x4949;
      const ifd0 = readIfd(view, tiffStart, view.getUint32(tiffStart + 4, little), little);

      let takenAt: string | null = null;
      const exifPointer = ifd0.get(TAG_EXIF_IFD);
      if (exifPointer) {
        const exif = readIfd(view, tiffStart, exifPointer.valueOffset, little);
        const dateEntry = exif.get(TAG_DATETIME_ORIGINAL);
        if (dateEntry) takenAt = parseExifDate(readAscii(view, tiffStart, dateEntry));
      }

      let lat: number | null = null;
      let lng: number | null = null;
      const gpsPointer = ifd0.get(TAG_GPS_IFD);
      if (gpsPointer) {
        const gps = readIfd(view, tiffStart, gpsPointer.valueOffset, little);
        const latEntry = gps.get(TAG_GPS_LAT);
        const lngEntry = gps.get(TAG_GPS_LNG);
        const latRef = gps.get(TAG_GPS_LAT_REF);
        const lngRef = gps.get(TAG_GPS_LNG_REF);
        if (latEntry && lngEntry && latRef && lngRef) {
          lat = toDecimalDegrees(readRationals(view, tiffStart, latEntry, little), readAscii(view, tiffStart, latRef));
          lng = toDecimalDegrees(readRationals(view, tiffStart, lngEntry, little), readAscii(view, tiffStart, lngRef));
        }
      }
      return { takenAt, lat, lng };
    }
    // Start of scan: metadata segments are over.
    if (marker === 0xffda) return EMPTY;
    offset += 2 + length;
  }
  return EMPTY;
}

export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return EMPTY;
  try {
    // EXIF lives in the first segments; 256 KB is plenty.
    return parseExif(await file.slice(0, 256 * 1024).arrayBuffer());
  } catch {
    return EMPTY;
  }
}
