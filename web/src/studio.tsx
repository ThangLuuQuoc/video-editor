import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ModelsResponse } from './api';
import { SAMPLE_SCRIPT, newId } from '../../src/core/constants';
import { assignVoices, detectLang, needsVoice, planSceneVoices, voiceSignature } from '../../src/core/voicePlan';
import type { CharacterItem, JobInfo, ModelInfo, Project, ProjectSettings, SceneItem, SkillInfo, VoiceInfo } from '../../src/core/types';

const LAST_PROJECT_KEY = 'ai-video:last-project';
const RENDER_FIELDS = ['status', 'errorMessage', 'video', 'lastRender', 'voice', 'renderRev'] as const;

export type VoiceState = 'none' | 'not-needed' | 'missing' | 'stale' | 'ok';

/**
 * Take what the server owns (render results, merged movie) from `server` into `local`, scene by
 * scene, when the server's revision counter is newer. Local edits to everything else are kept.
 */
function adoptServer(local: Project, server: Project): Project {
  const byId = new Map(server.scenes.map(s => [s.id, s]));
  let changed = false;
  const scenes = local.scenes.map(sc => {
    const sv = byId.get(sc.id);
    if (!sv || (sv.renderRev ?? 0) <= (sc.renderRev ?? 0)) return sc;
    changed = true;
    const next = { ...sc };
    for (const k of RENDER_FIELDS) (next as any)[k] = sv[k];
    return next;
  });
  const out: Project = { ...local, scenes, revision: Math.max(local.revision ?? 0, server.revision ?? 0) };
  if ((server.mergeRev ?? 0) > (local.mergeRev ?? 0)) {
    changed = true;
    Object.assign(out, { merged: server.merged, mergedSubtitles: server.mergedSubtitles, mergeWarnings: server.mergeWarnings, mergeRev: server.mergeRev });
  }
  return changed || out.revision !== local.revision ? out : local;
}

function useStudioState() {
  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [subtitlesOk, setSubtitlesOk] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [castProgress, setCastProgress] = useState('');
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);

  // Always-current project for async flows; `dirty` = local edits not yet saved.
  const projectRef = useRef<Project | null>(null);
  const dirty = useRef(false);
  const jobsRef = useRef<JobInfo[]>([]);
  jobsRef.current = jobs;

  const flash = useCallback((kind: 'info' | 'warn' | 'error', text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(n => (n?.text === text ? null : n)), kind === 'error' ? 9000 : 6000);
  }, []);

  const setLocal = useCallback((p: Project) => {
    projectRef.current = p;
    setProject(p);
  }, []);

  // ---- boot -------------------------------------------------------------------------------
  const openProject = useCallback(
    async (id?: string) => {
      let p: Project | null = null;
      if (id) p = await api.getProject(id).catch(() => null);
      if (!p) p = await api.createProject({ name: 'Phố cổ & cơn mưa', script: SAMPLE_SCRIPT });
      const running = await api.runningJobs(p.id).catch(() => [] as JobInfo[]);
      if (!running.length && p.scenes.some(s => s.status === 'generating')) {
        // Left "generating" by a server that stopped — not running anymore.
        p.scenes = p.scenes.map(s => (s.status === 'generating' ? { ...s, status: s.video ? 'completed' : 'idle' } : s));
        dirty.current = true;
      } else dirty.current = false;
      try {
        localStorage.setItem(LAST_PROJECT_KEY, p.id);
      } catch {}
      const url = new URL(location.href);
      url.searchParams.set('project', p.id);
      history.replaceState(null, '', url);
      setJobs(running);
      setLocal(p);
    },
    [setLocal]
  );

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode runs effects twice — don't create two projects
    booted.current = true;
    (async () => {
      try {
        const [m, s, h] = await Promise.all([api.models(), api.skills(), api.health()]);
        setModels(m);
        setSkills(s);
        setFfmpegOk(h.ffmpeg.ok);
        setSubtitlesOk(h.ffmpeg.subtitles);
        let last: string | undefined;
        try {
          last = localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
        } catch {}
        await openProject(new URLSearchParams(location.search).get('project') ?? last);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
  }, [openProject]);

  // ---- saving -------------------------------------------------------------------------------
  const saving = useRef<Promise<void> | null>(null);
  const saveNow = useCallback(async () => {
    const sent = projectRef.current;
    if (!sent || !dirty.current) return;
    const p = (async () => {
      try {
        const saved = await api.saveProject(sent);
        if (projectRef.current === sent) dirty.current = false;
        if (projectRef.current) setLocal(adoptServer(projectRef.current, saved));
      } catch (e) {
        console.warn('autosave', e);
      }
    })();
    saving.current = p;
    await p;
    if (saving.current === p) saving.current = null;
  }, [setLocal]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!project || !dirty.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 800);
  }, [project, saveNow]);

  /** Flush pending edits before a server job reads the project from disk. */
  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    if (saving.current) await saving.current;
    await saveNow();
  }, [saveNow]);

  // ---- sync with the server (job progress, results, changes made via MCP) ---------------------
  const refresh = useCallback(async () => {
    const cur = projectRef.current;
    if (!cur) return;
    const server = await api.getProject(cur.id).catch(() => null);
    const now = projectRef.current;
    if (!server || !now || now.id !== server.id) return;
    // Changed elsewhere (MCP / another tab) and nothing local pending → take it whole.
    if (!dirty.current && !saving.current && (server.revision ?? 0) > (now.revision ?? 0) && !jobsRef.current.length) setLocal(server);
    else setLocal(adoptServer(now, server));
  }, [setLocal]);

  /** render-all jobs started with thenMerge (to word the completion message). */
  const jobMerges = useRef(new Set<string>());
  const onJobDone = useCallback(
    (j: JobInfo) => {
      const label: Record<string, string> = { 'render-all': 'Render hàng loạt', render: 'Render cảnh', voice: 'Lồng tiếng', merge: 'Ghép video' };
      const what = label[j.kind] ?? j.kind;
      if (j.status === 'canceled') return flash('warn', `⏹ Đã dừng: ${what}`);
      if (j.status === 'error') return flash('error', `${what} thất bại: ${j.error}`);
      const p = j.result as Project | SceneItem | undefined;
      const merged = j.kind === 'merge' || (j.kind === 'render-all' && jobMerges.current.has(j.id));
      jobMerges.current.delete(j.id);
      if (merged) {
        const warns = (p as Project)?.mergeWarnings ?? [];
        flash(warns.length ? 'warn' : 'info', warns.length ? `Đã ghép video, lưu ý: ${warns.join(' · ')}` : '✅ Đã ghép hoàn chỉnh video toàn bộ kịch bản!');
      } else if (j.kind === 'render-all') {
        const failed = (p as Project)?.scenes?.filter(s => s.status === 'error').length ?? 0;
        flash(failed ? 'warn' : 'info', failed ? `Render xong, ${failed} cảnh lỗi` : '✅ Đã render xong các cảnh');
      } else if (j.kind === 'render' && (p as SceneItem)?.status === 'error') {
        flash('error', `Cảnh ${(p as SceneItem).sceneNumber} lỗi: ${(p as SceneItem).errorMessage}`);
      }
    },
    [flash]
  );

  useEffect(() => {
    if (!project?.id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const active = jobsRef.current;
      if (active.length) {
        const fresh = await Promise.all(active.map(j => api.job(j.id).catch(() => ({ ...j, status: 'error', error: 'Server mất job (đã khởi động lại?)' }) as JobInfo)));
        const finished = fresh.filter(j => j.status !== 'running');
        setJobs(fresh.filter(j => j.status === 'running'));
        await refresh();
        finished.forEach(onJobDone);
      } else {
        await refresh();
      }
      if (!stop) timer = setTimeout(tick, jobsRef.current.length ? 1500 : 4000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [project?.id, refresh, onJobDone]);

  // ---- helpers ------------------------------------------------------------------------------
  // Apply updates to the ref synchronously so async flows never read stale state.
  const update = useCallback(
    (fn: (p: Project) => Project) => {
      const cur = projectRef.current;
      if (!cur) return;
      dirty.current = true;
      setLocal(fn(cur));
    },
    [setLocal]
  );
  const setSettings = useCallback((patch: Partial<ProjectSettings>) => update(p => ({ ...p, settings: { ...p.settings, ...patch } })), [update]);
  const patchScene = useCallback(
    (id: string, patch: Partial<SceneItem>) => update(p => ({ ...p, scenes: p.scenes.map(s => (s.id === id ? { ...s, ...patch } : s)) })),
    [update]
  );
  const setScenes = useCallback(
    (fn: (s: SceneItem[]) => SceneItem[]) => update(p => ({ ...p, scenes: fn(p.scenes).map((s, i) => ({ ...s, sceneNumber: i + 1 })) })),
    [update]
  );

  const effective = (kind: 'text' | 'image' | 'video' | 'tts'): string => {
    const p = projectRef.current;
    const key = `${kind}Model` as const;
    return p?.settings[key] || (models?.defaults[key] as string) || '';
  };

  const videoModel: ModelInfo | undefined = useMemo(() => {
    const id = project?.settings.videoModel || models?.defaults.videoModel;
    return models?.video.find(m => m.id === id);
  }, [project?.settings.videoModel, models]);

  const ttsModel: ModelInfo | undefined = useMemo(() => {
    const id = project?.settings.ttsModel || models?.defaults.ttsModel;
    return models?.tts?.find(m => m.id === id);
  }, [project?.settings.ttsModel, models]);
  const voices: VoiceInfo[] = ttsModel?.voices ?? [];
  const lang = useMemo(() => detectLang(project?.scenes.map(s => s.dialogue).join('\n') ?? ''), [project?.scenes]);
  /** Voice each character gets (manual pick or auto-cast). */
  const castVoices = useMemo(
    () => (project && ttsModel ? assignVoices(project.characters, voices, ttsModel.id, lang) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.characters, ttsModel, lang]
  );

  const voiceState = (sc: SceneItem): VoiceState => {
    const p = projectRef.current;
    if (!p || !sc.dialogue.trim()) return 'none';
    const vid = sc.lastRender?.model || effective('video');
    const hasAudio = models?.video.find(m => m.id === vid)?.supportsAudio !== false;
    if (!needsVoice(sc, p.settings, hasAudio)) return 'not-needed';
    if (!sc.voice) return 'missing';
    if (!ttsModel) return 'ok';
    const sig = voiceSignature(ttsModel.id, planSceneVoices(sc, p.characters, p.settings, ttsModel.id, voices, lang));
    return sig === sc.voice.signature ? 'ok' : 'stale';
  };

  // ---- server jobs --------------------------------------------------------------------------
  const startJob = useCallback(
    async (action: 'render' | 'voice' | 'render-all' | 'merge', body: unknown = {}) => {
      const p = projectRef.current;
      if (!p) return;
      try {
        await flushSave();
        const job = await api.startProjectJob(p.id, action, body);
        setJobs(js => [...js, job]);
        await refresh();
        return job;
      } catch (e) {
        flash('error', (e as Error).message);
      }
    },
    [flushSave, refresh, flash]
  );

  const cancelJob = useCallback(
    async (id?: string) => {
      const ids = id ? [id] : jobsRef.current.map(j => j.id);
      await Promise.all(ids.map(x => api.cancelJob(x).catch(() => {})));
      setJobs(js => js.map(j => (ids.includes(j.id) ? { ...j, progress: 'Đang hủy...' } : j)));
    },
    []
  );

  const renderScene = useCallback((sceneId: string) => startJob('render', { sceneId }), [startJob]);
  const voiceScene = useCallback((sceneId: string) => startJob('voice', { sceneId }), [startJob]);
  const renderAll = useCallback(
    (opts: { onlyMissing: boolean; thenMerge: boolean }) => {
      if (jobsRef.current.some(j => j.kind === 'render-all' || j.kind === 'merge')) return;
      return startJob('render-all', opts).then(job => {
        if (job && opts.thenMerge) jobMerges.current.add(job.id);
        return job;
      });
    },
    [startJob]
  );
  const merge = useCallback(() => {
    const p = projectRef.current!;
    if (!p.scenes.some(s => s.status === 'completed' && s.video)) return flash('warn', 'Chưa có phân cảnh nào hoàn tất để ghép');
    return startJob('merge');
  }, [startJob, flash]);

  const batchJob = jobs.find(j => j.kind === 'render-all');
  const mergeJob = jobs.find(j => j.kind === 'merge');
  const isBatch = !!batchJob;
  const isMerging = !!mergeJob || (!!batchJob && /ghép|chuẩn hóa|nối/i.test(batchJob.progress));
  const generatingIdx = project?.scenes.findIndex(s => s.status === 'generating') ?? -1;
  // "[3/6] …" from the server job, else the scene currently marked generating.
  const step = batchJob?.progress.match(/^\[(\d+)\/\d+\]/);
  const batchIndex = !isBatch ? null : generatingIdx >= 0 ? generatingIdx : step ? Number(step[1]) - 1 : null;
  const jobForScene = (sceneId: string) => jobs.find(j => j.sceneId === sceneId);
  const busy = jobs.length > 0;

  // ---- client-side steps (fast, stateless endpoints) ------------------------------------------
  const autoCast = useCallback(
    async (scenes?: SceneItem[]) => {
      const p = projectRef.current!;
      setIsCasting(true);
      try {
        const r = await api.autoCast(
          {
            script: p.script,
            scenes: scenes ?? p.scenes,
            characters: p.characters,
            skillIds: p.settings.skillIds,
            textModel: effective('text'),
            imageModel: effective('image')
          },
          setCastProgress
        );
        update(cur => ({
          ...cur,
          characters: r.characters,
          // keep any edits made meanwhile: only take the new bindings
          scenes: cur.scenes.map(s => ({ ...s, selectedCharacterIds: r.scenes.find(x => x.id === s.id)?.selectedCharacterIds ?? s.selectedCharacterIds }))
        }));
        if (r.warnings.length) flash('warn', `Một số chân dung lỗi: ${r.warnings.join('; ')}`);
      } catch (e) {
        flash('error', `Tạo nhân vật thất bại: ${(e as Error).message}`);
      } finally {
        setIsCasting(false);
        setCastProgress('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, flash, models]
  );

  const analyze = useCallback(async () => {
    const p = projectRef.current!;
    if (!p.script.trim()) return;
    if (jobsRef.current.length) return flash('warn', 'Đang có tác vụ render/ghép chạy — hãy chờ hoặc dừng trước khi tách cảnh lại');
    setIsAnalyzing(true);
    try {
      const r = await api.analyze({
        script: p.script,
        mode: p.settings.scriptMode,
        skillIds: p.settings.skillIds,
        textModel: effective('text'),
        characters: p.characters
      });
      update(cur => ({ ...cur, scenes: r.scenes, merged: undefined, mergedSubtitles: undefined, mergeWarnings: undefined }));
      flash(r.warning ? 'warn' : 'info', r.warning ?? `Đã tách ${r.scenes.length} cảnh (engine: ${r.engine})`);
      if (p.settings.autoGenerateCharacters) await autoCast(r.scenes);
    } catch (e) {
      flash('error', `Phân tích thất bại: ${(e as Error).message}`);
    } finally {
      setIsAnalyzing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, flash, autoCast, models]);

  const addScene = () =>
    setScenes(sc => [
      ...sc,
      {
        id: newId('sc'),
        sceneNumber: sc.length + 1,
        title: `Phân cảnh mới ${sc.length + 1}`,
        promptDescription: 'Cinematic composition, dynamic character interaction, atmospheric lighting, detailed setting',
        action: '',
        setting: '',
        cameraAngle: 'Medium Shot (Trung cảnh)',
        durationSeconds: 5,
        dialogue: '',
        audioDirection: '',
        characterNames: [],
        selectedCharacterIds: [],
        status: 'idle'
      }
    ]);

  const duplicateScene = (index: number) =>
    setScenes(sc => {
      const t = sc[index];
      const copy: SceneItem = {
        ...t,
        id: newId('sc'),
        title: `${t.title} (Bản sao)`,
        status: 'idle',
        video: undefined,
        voice: undefined,
        errorMessage: undefined,
        lastRender: undefined,
        renderRev: undefined
      };
      return [...sc.slice(0, index + 1), copy, ...sc.slice(index + 1)];
    });

  const deleteScene = (index: number) => setScenes(sc => (sc.length <= 1 ? sc : sc.filter((_, i) => i !== index)));
  const moveScene = (index: number, dir: -1 | 1) =>
    setScenes(sc => {
      const j = index + dir;
      if (j < 0 || j >= sc.length) return sc;
      const next = [...sc];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });

  const addCharacter = (c: CharacterItem) =>
    update(p => ({
      ...p,
      characters: [...p.characters, c],
      scenes: p.scenes.map(s =>
        s.characterNames.some(n => n.toLowerCase() === c.name.toLowerCase()) ? { ...s, selectedCharacterIds: [...new Set([...s.selectedCharacterIds, c.id])] } : s
      )
    }));
  const removeCharacter = (id: string) =>
    update(p => ({
      ...p,
      characters: p.characters.filter(c => c.id !== id),
      scenes: p.scenes.map(s => ({ ...s, selectedCharacterIds: s.selectedCharacterIds.filter(x => x !== id) }))
    }));
  const setCharacterVoice = (id: string, voiceId: string) =>
    update(p => ({
      ...p,
      characters: p.characters.map(c => (c.id !== id ? c : { ...c, voice: voiceId ? { model: effective('tts'), id: voiceId } : undefined }))
    }));
  const toggleCharacterInScene = (sceneId: string, charId: string) =>
    update(p => ({
      ...p,
      scenes: p.scenes.map(s =>
        s.id !== sceneId
          ? s
          : { ...s, selectedCharacterIds: s.selectedCharacterIds.includes(charId) ? s.selectedCharacterIds.filter(x => x !== charId) : [...s.selectedCharacterIds, charId] }
      )
    }));

  const toggleSkill = (skill: SkillInfo) =>
    update(p => {
      const has = p.settings.skillIds.includes(skill.id);
      let ids = has ? p.settings.skillIds.filter(x => x !== skill.id) : [...p.settings.skillIds, skill.id];
      // A project has at most one visual "style" skill.
      if (!has && skill.category === 'style') ids = ids.filter(x => x === skill.id || skills.find(s => s.id === x)?.category !== 'style');
      const aspect = !has && skill.aspectRatio ? { aspectRatio: skill.aspectRatio } : {};
      return { ...p, settings: { ...p.settings, skillIds: ids, ...aspect } };
    });

  const reloadSkills = async () => setSkills(await api.skills());

  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const previewVoice = async (voice: string, text?: string) => {
    try {
      const a = await api.ttsPreview({ model: effective('tts'), voice, text });
      previewAudio.current?.pause();
      previewAudio.current = new Audio(a.url);
      await previewAudio.current.play();
    } catch (e) {
      flash('error', `Nghe thử giọng lỗi: ${(e as Error).message}`);
    }
  };

  return {
    project,
    models,
    skills,
    ffmpegOk,
    subtitlesOk,
    loadError,
    videoModel,
    ttsModel,
    voices,
    castVoices,
    voiceState,
    isAnalyzing,
    isCasting,
    castProgress,
    jobs,
    busy,
    batchJob,
    mergeJob,
    isBatch,
    batchIndex,
    isMerging,
    jobForScene,
    notice,
    setNotice,
    flash,
    update,
    setSettings,
    patchScene,
    openProject,
    analyze,
    autoCast,
    renderScene,
    voiceScene,
    renderAll,
    merge,
    cancelJob,
    addScene,
    duplicateScene,
    deleteScene,
    moveScene,
    addCharacter,
    removeCharacter,
    setCharacterVoice,
    toggleCharacterInScene,
    toggleSkill,
    reloadSkills,
    previewVoice,
    effective
  };
}

export type Studio = ReturnType<typeof useStudioState>;
const StudioContext = createContext<Studio | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const studio = useStudioState();
  return <StudioContext.Provider value={studio}>{children}</StudioContext.Provider>;
}

export function useStudio(): Studio {
  const s = useContext(StudioContext);
  if (!s) throw new Error('useStudio outside provider');
  return s;
}
