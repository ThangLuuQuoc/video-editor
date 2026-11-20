// Shared domain types — imported by both the Node server and the web UI (type-only, no Node APIs here).

export type VideoResolution = '360p' | '480p' | '720p' | '1080p';
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
export type ScriptMode = 'strict' | 'educational' | 'cinematic';
export type ModelKind = 'text' | 'image' | 'video' | 'tts';
/** auto = lồng tiếng khi model video không có âm thanh; always = luôn; off = tắt. */
export type VoiceMode = 'auto' | 'always' | 'off';
/** subject = ảnh là tham chiếu nhân vật; first-frame = ảnh được dùng làm khung hình đầu (image-to-video). */
export type ReferenceMode = 'subject' | 'first-frame';

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
  /** Giọng TTS chọn tay cho nhân vật (theo từng model TTS). Không có → tự chọn theo tuổi/giới tính. */
  voice?: { model: string; id: string };
}

export interface VoiceInfo {
  id: string;
  label: string;
  gender?: 'female' | 'male';
  age?: 'child' | 'young' | 'adult' | 'elder';
  /** BCP-47, ví dụ "en-US", "vi-VN". Bỏ trống = đa ngôn ngữ. */
  lang?: string;
}

export interface VoiceCue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** Track lồng tiếng của một cảnh: các câu thoại nối nhau, kèm mốc thời gian thật của từng câu. */
export interface SceneVoice {
  audio: MediaAsset;
  cues: VoiceCue[];
  durationSeconds: number;
  model: string;
  /** Băm (thoại + giọng + model) — khác đi nghĩa là track đã cũ. */
  signature: string;
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
  lastRender?: {
    model: string;
    durationSeconds: number;
    resolution: string;
    prompt: string;
    /** Cách gửi ảnh nhân vật: none | direct | sheet (ảnh ghép) | keyframe (khung hình đầu dựng bằng model ảnh). */
    references?: 'none' | 'direct' | 'sheet' | 'keyframe';
    keyframe?: MediaAsset;
    notes?: string[];
  };
  voice?: SceneVoice;
  /** Tăng mỗi khi server ghi kết quả render/lồng tiếng — dùng để gộp an toàn giữa web, MCP và job nền. */
  renderRev?: number;
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
  voiceMode: VoiceMode;
  ttsModel: string;
  /** Giọng cho câu thoại không rõ người nói / lời dẫn. */
  narratorVoice?: string;
  /** Model ảnh dựng khung hình đầu cho model image-to-video ('' = tự chọn, 'off' = tắt). */
  keyframeModel?: string;
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
  mergeWarnings?: string[];
  mergeRev?: number;
  /** Tăng mỗi lần lưu. */
  revision?: number;
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
  referenceMode?: ReferenceMode;
  supportsAudio?: boolean;
  voices?: VoiceInfo[];
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
  status: 'running' | 'done' | 'error' | 'canceled';
  progress: string;
  projectId?: string;
  sceneId?: string;
  result?: T;
  error?: string;
  createdAt: string;
}
