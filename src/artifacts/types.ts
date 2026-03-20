export interface ArtifactInfo {
  id: string;
  name: string;
  size: number;
  created_at: string;
  inline: boolean;
}

export interface ArtifactIndex {
  artifacts: Record<string, ArtifactEntry>;
}

export interface ArtifactEntry {
  id: string;
  name: string;
  size: number;
  created_at: string;
  inline: boolean;
  data?: string; // inline payload for ≤100KB
}
