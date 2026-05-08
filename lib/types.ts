export type EnforcementKind = "fixed" | "tech" | "mobile";

export interface EnforcementPoint {
  id: string;
  kind: EnforcementKind;
  city: string;
  district: string;
  address: string;
  lat: number;
  lng: number;
  speedLimit?: number;
  direction?: string;
  authority?: string;
  branch?: string;
  enforcementType?: string;
  notes?: string;
}

export interface DataBundle {
  generatedAt: string;
  sources: Array<{
    kind: EnforcementKind;
    label: string;
    sourceUrl: string;
    sourceUpdatedAt: string | null;
    fetchedAt: string;
    license: string;
    count: number;
  }>;
  points: EnforcementPoint[];
}
