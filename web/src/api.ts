import type { CharacterItem, JobInfo, MediaAsset, ModelInfo, Project, ProjectSettings, SceneItem, SkillInfo } from '../../src/core/types';

export async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

/** Start a background job on the server and poll it until it finishes (for short stateless jobs). */
async function runJob<T>(url: string, body: unknown, onProgress?: (msg: string) => void): Promise<T> {
  let job = await req<JobInfo<T>>('POST', url, body);
  while (job.status === 'running') {
    onProgress?.(job.progress);
    await new Promise(r => setTimeout(r, 1500));
    job = await req<JobInfo<T>>('GET', `/api/jobs/${job.id}`);
  }
  if (job.status !== 'done') throw new Error(job.error || 'Job lỗi');
  return job.result as T;
}

export interface ModelsResponse {
  text: ModelInfo[];
  image: ModelInfo[];
  video: ModelInfo[];
  tts: ModelInfo[];
  defaults: Partial<ProjectSettings>;
}

export interface Health {
  ffmpeg: { ok: boolean; version: string; subtitles: boolean };
}

export const api = {
  health: () => req<Health>('GET', '/api/health'),
  models: () => req<ModelsResponse>('GET', '/api/models'),
  skills: () => req<SkillInfo[]>('GET', '/api/skills'),
  saveSkill: (s: Omit<SkillInfo, 'source'>) => req<SkillInfo>('POST', '/api/skills', s),
  deleteSkill: (id: string) => req('DELETE', `/api/skills/${id}`),

  listProjects: () => req<{ id: string; name: string; updatedAt: string; scenes: number }[]>('GET', '/api/projects'),
  createProject: (init: { name?: string; script?: string }) => req<Project>('POST', '/api/projects', init),
  getProject: (id: string) => req<Project>('GET', `/api/projects/${id}`),
  saveProject: (p: Project) => req<Project>('PUT', `/api/projects/${p.id}`, p),
  deleteProject: (id: string) => req('DELETE', `/api/projects/${id}`),

  analyze: (body: { script: string; mode: string; skillIds: string[]; textModel: string; characters: CharacterItem[] }) =>
    req<{ scenes: SceneItem[]; engine: string; warning?: string }>('POST', '/api/script/analyze', body),
  autoCast: (body: unknown, onProgress?: (m: string) => void) =>
    runJob<{ characters: CharacterItem[]; scenes: SceneItem[]; warnings: string[] }>('/api/characters/auto', body, onProgress),
  portrait: (body: unknown) => runJob<CharacterItem>('/api/characters/portrait', body),
  uploadCharacter: (body: { name: string; description?: string; dataUrl: string }) => req<CharacterItem>('POST', '/api/characters/upload', body),
  scenePrompt: (body: unknown) => req<{ prompt: string; negativePrompt?: string; references: string; notes: string[] }>('POST', '/api/scenes/prompt', body),
  ttsPreview: (body: { model: string; voice: string; text?: string; instructions?: string }) => req<MediaAsset>('POST', '/api/tts/preview', body),
  mediaGc: (dryRun: boolean) => req<{ files: number; bytes: number }>('POST', '/api/media/gc', { dryRun }),

  // Project jobs (run on the server against the saved project; survive a closed tab)
  startProjectJob: (projectId: string, action: 'render' | 'voice' | 'render-all' | 'merge', body: unknown = {}) =>
    req<JobInfo>('POST', `/api/projects/${projectId}/${action}`, body),
  job: (id: string) => req<JobInfo>('GET', `/api/jobs/${id}`),
  runningJobs: (projectId: string) => req<JobInfo[]>('GET', `/api/jobs?projectId=${encodeURIComponent(projectId)}&running=1`),
  cancelJob: (id: string) => req<JobInfo>('POST', `/api/jobs/${id}/cancel`)
};
