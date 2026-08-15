declare module "tz-lookup" {
  /** Returns the IANA timezone name for a given latitude/longitude. */
  export default function tzLookup(lat: number, lng: number): string;
}
