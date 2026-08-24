declare module "@google/earthengine" {
  export const data: {
    authenticateViaPrivateKey: (
      key: unknown,
      success: () => void,
      error: (error: unknown) => void,
    ) => void;
  };

  export function initialize(
    baseurl: string | null,
    tileurl: string | null,
    success: () => void,
    error: (error: unknown) => void,
    xsrfToken?: string | null,
    project?: string,
  ): void;

  export const Geometry: {
    Point: (coordinates: [number, number]) => {
      buffer: (distance: number) => unknown;
    };
  };

  export function ImageCollection(collectionId: string): {
    select: (band: string) => {
      filterDate: (start: string, end: string) => {
        filterBounds: (geometry: unknown) => {
          median: () => {
            reduceRegion: (options: {
              reducer: unknown;
              geometry: unknown;
              scale: number;
              maxPixels: number;
            }) => {
              get: (band: string) => {
                getInfo: (
                  success: (value: number | null) => void,
                  error: (error: unknown) => void,
                ) => void;
              };
            };
          };
        };
      };
    };
  };

  export const ApiFunction: {
    _call: (name: string, ...args: unknown[]) => unknown;
  };
}
