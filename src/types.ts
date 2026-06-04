export interface RenderMediaRequest {
  compositionId: string;
  inputProps?: Record<string, unknown>;
}

export interface RenderMediaResponse {
  message: string;
  fileName: string; // e.g. "uuid.mp4"
}

export interface RenderStatusResponse {
  status: RenderStatus;
  url?: string; // présent uniquement si COMPLETED
  fileName: string;
}

export enum RenderStatus {
  PENDING = 'pending',     // GET /download/<fileName> → 404
  COMPLETED = 'completed', // GET /download/<fileName> → 200
  ERROR = 'error',         // erreur réseau ou serveur
}
