// Minimal hand-written typings for the parts of @google/earthengine we call.
// EE objects are lazy server-side expression builders, so one chainable
// interface models Image, ImageCollection, and FeatureCollection closely
// enough for our usage.
declare module "@google/earthengine" {
  type Callback<T> = (value: T) => void;
  type ErrorCallback = (error: unknown) => void;

  export interface EEObject {
    select: (bands: string | string[]) => EEObject;
    filterDate: (start: string, end: string) => EEObject;
    filterBounds: (geometry: unknown) => EEObject;
    median: () => EEObject;
    max: () => EEObject;
    limit: (max: number) => EEObject;
    sample: (options: {
      region: unknown;
      scale: number;
      geometries?: boolean;
      dropNulls?: boolean;
      numPixels?: number;
    }) => EEObject;
    reduceRegion: (options: {
      reducer: unknown;
      geometry: unknown;
      scale: number;
      maxPixels: number;
    }) => EEObject;
    get: (property: string) => EEObject;
    getInfo: <T>(success: Callback<T>, error: ErrorCallback) => void;
  }

  export const data: {
    authenticateViaPrivateKey: (
      key: unknown,
      success: () => void,
      error: ErrorCallback,
    ) => void;
  };

  export function initialize(
    baseurl: string | null,
    tileurl: string | null,
    success: () => void,
    error: ErrorCallback,
    xsrfToken?: string | null,
    project?: string,
  ): void;

  export const Geometry: {
    Point: (coordinates: [number, number]) => {
      buffer: (distance: number) => unknown;
    };
    Rectangle: (coordinates: [number, number, number, number]) => unknown;
  };

  export function ImageCollection(collectionId: string): EEObject;

  export const ApiFunction: {
    _call: (name: string, ...args: unknown[]) => unknown;
  };
}
