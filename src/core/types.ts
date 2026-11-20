// Shared domain types — imported by both the Node server and the web UI (type-only, no Node APIs here).

export type VideoResolution = '360p' | '480p' | '720p' | '1080p';
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
export type ScriptMode = 'strict' | 'educational' | 'cinematic';
export type ModelKind = 'text' | 'image' | 'video';

export type CameraAngle =
  | 'Wide Shot (Toàn cảnh)'
  | 'Medium Shot (Trung cảnh)'
  | 'Close-up (Cận cảnh)'
  | 'Tracking Shot (Bám theo)'
  | 'Drone Aerial (Góc cao)'
  | 'Low Angle (Góc ngước lên)'
  | 'Over-the-shoulder (Qua vai)';

/** A file stored in the local media folder and served at `url`. */
export interface MediaAsset {
  id: string;
  file: string; // file name inside the media dir
  url: string; // e.g. /media/abc.mp4
  mimeType: string;
  path?: string; // absolute path (server side only, useful for MCP clients)
  durationSeconds?: number;
}

export interface CharacterSpec {
  name: string;
  imagePrompt?: string;
  description?: string;
}

export interface CharacterItem extends CharacterSpec {
  id: string;
  image?: MediaAsset;
}

export type SceneStatus = 'idle' | 'generating' | 'completed' | 'error';

export interface SceneItem {
  id: string;
  sceneNumber: number;
  title: string;
  promptDescription: string;
  action: string;
  setting: string;
  cameraAngle: CameraAngle;
  durationSeconds: number;
  dialogue: string;
  audioDirection: string;
  characterNames: string[];
  selectedCharacterIds: string[];
  status: SceneStatus;
  errorMessage?: string;
  video?: MediaAsset;
  /** What was actually sent to the model (after duration/resolution snapping). */
  lastRender?: { model: string; durationSeconds: number; resolution: string; prompt: string };
}

export interface ProjectSettings {
  scriptMode: ScriptMode;
  skillIds: string[];
  textModel: string;
  imageModel: string;
  videoModel: string;
  resolution: VideoResolution;
  aspectRatio: AspectRatio;
  burnInSubtitles: boolean;
  autoGenerateCharacters: boolean;
}

export interface Project {
  id: string;
  name: string;
  script: string;
  settings: ProjectSettings;
  characters: CharacterItem[];
  scenes: SceneItem[];
  merged?: MediaAsset;
  mergedSubtitles?: MediaAsset;
  createdAt: string;
  updatedAt: string;
}

/** Model as exposed to clients (UI / MCP). */
export interface ModelInfo {
  id: string;
  kind: ModelKind;
  label: string;
  provider: string;
  providerType: string;
  description?: string;
  badge?: string;
  cost?: string;
  available: boolean;
  unavailableReason?: string;
  durations?: number[];
  minDuration?: number;
  maxDuration?: number;
  resolutions?: VideoResolution[];
  aspectRatios?: AspectRatio[];
  maxReferenceImages?: number;
  supportsAudio?: boolean;
}

export interface SkillInfo {
  id: string;
  name: string;
  category: string; // style | genre | format | ...
  description: string;
  tags: string[];
  promptModifier?: string;
  negativePrompt?: string;
  aspectRatio?: AspectRatio;
  defaultCameraAngle?: CameraAngle;
  portraitStyle?: string;
  directives: string; // markdown body: instructions for the script director LLM
  source: 'builtin' | 'user';
}

export interface JobInfo<T = unknown> {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'error';
  progress: string;
  result?: T;
  error?: string;
  createdAt: string;
}
