import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ModelsResponse } from './api';
import { SAMPLE_SCRIPT, newId } from '../../src/core/constants';
import type { CharacterItem, ModelInfo, Project, ProjectSettings, SceneItem, SkillInfo } from '../../src/core/types';

const LAST_PROJECT_KEY = 'ai-video:last-project';

function useStudioState() {
  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [isBatch, setIsBatch] = useState(false);
  const [batchIndex, setBatchIndex] = useState<number | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);

  // Always-current project for async flows (fixes the stale-closure bugs of the Flow version).
  const projectRef = useRef<Project | null>(null);

  const flash = useCallback((kind: 'info' | 'warn' | 'error', text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(n => (n?.text === text ? null : n)), kind === 'error' ? 9000 : 5000);
  }, []);

  // ---- boot -------------------------------------------------------------------------------
  const openProject = useCallback(async (id?: string) => {
    let p: Project | null = null;
    if (id) p = await api.getProject(id).catch(() => null);
    if (!p) p = await api.createProject({ name: 'Phố cổ & cơn mưa', script: SAMPLE_SCRIPT });
    // Scenes left "generating" by a closed tab are not running anymore.
    p.scenes = p.scenes.map(s => (s.status === 'generating' ? { ...s, status: s.video ? 'completed' : 'idle' } : s));
    try {
      localStorage.setItem(LAST_PROJECT_KEY, p.id);
    } catch {}
    const url = new URL(location.href);
    url.searchParams.set('project', p.id);
    history.replaceState(null, '', url);
    projectRef.current = p;
    setProject(p);
  }, []);

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

  // ---- autosave (debounced) -----------------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!project) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.saveProject(project).catch(e => console.warn('autosave', e));
    }, 800);
  }, [project]);

  // ---- helpers ------------------------------------------------------------------------------
  // Apply updates to the ref synchronously so async flows (render → merge) never read stale state.
  const update = useCallback((fn: (p: Project) => Project) => {
    const cur = projectRef.current;
    if (!cur) return;
    const next = fn(cur);
    projectRef.current = next;
    setProject(next);
  }, []);
  const setSettings = useCallback((patch: Partial<ProjectSettings>) => update(p => ({ ...p, settings: { ...p.settings, ...patch } })), [update]);
  const patchScene = useCallback(
    (id: string, patch: Partial<SceneItem>) => update(p => ({ ...p, scenes: p.scenes.map(s => (s.id === id ? { ...s, ...patch } : s)) })),
    [update]
  );
  const setScenes = useCallback(
    (fn: (s: SceneItem[]) => SceneItem[]) => update(p => ({ ...p, scenes: fn(p.scenes).map((s, i) => ({ ...s, sceneNumber: i + 1 })) })),
    [update]
  );

  const effective = (kind: 'text' | 'image' | 'video'): string => {
    const p = projectRef.current;
    const key = `${kind}Model` as const;
    return p?.settings[key] || (models?.defaults[key] as string) || '';
  };

  const videoModel: ModelInfo | undefined = useMemo(() => {
    const id = project?.settings.videoModel || models?.defaults.videoModel;
    return models?.video.find(m => m.id === id);
  }, [project?.settings.videoModel, models]);

  // ---- actions ------------------------------------------------------------------------------
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
          setProgress
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
        setProgress('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, flash, models]
  );

  const analyze = useCallback(async () => {
    const p = projectRef.current!;
    if (!p.script.trim()) return;
    setIsAnalyzing(true);
    setProgress('Đang đọc kịch bản và phân tích từng phân cảnh...');
    try {
      const r = await api.analyze({
        script: p.script,
        mode: p.settings.scriptMode,
        skillIds: p.settings.skillIds,
        textModel: effective('text'),
        characters: p.characters
      });
      update(cur => ({ ...cur, scenes: r.scenes, merged: undefined, mergedSubtitles: undefined }));
      flash(r.warning ? 'warn' : 'info', r.warning ?? `Đã tách ${r.scenes.length} cảnh (engine: ${r.engine})`);
      if (p.settings.autoGenerateCharacters) await autoCast(r.scenes);
    } catch (e) {
      flash('error', `Phân tích thất bại: ${(e as Error).message}`);
    } finally {
      setIsAnalyzing(false);
      setProgress('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, flash, autoCast, models]);

  const renderScene = useCallback(
    async (sceneId: string): Promise<boolean> => {
      const p = projectRef.current!;
      const scene = p.scenes.find(s => s.id === sceneId);
      if (!scene) return false;
      patchScene(sceneId, { status: 'generating', errorMessage: undefined });
      try {
        const r = await api.renderScene({ scene, characters: p.characters, settings: { ...p.settings, videoModel: effective('video') } });
        patchScene(sceneId, { status: 'completed', video: r.video, lastRender: r.lastRender });
        return true;
      } catch (e) {
        patchScene(sceneId, { status: 'error', errorMessage: (e as Error).message });
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchScene, models]
  );

  const merge = useCallback(async () => {
    const p = projectRef.current!;
    if (!p.scenes.some(s => s.status === 'completed' && s.video)) return flash('warn', 'Chưa có phân cảnh nào hoàn tất để ghép');
    setIsMerging(true);
    try {
      const r = await api.merge({ scenes: p.scenes, settings: p.settings }, setProgress);
      update(cur => ({ ...cur, merged: { ...r.video, durationSeconds: r.durationSeconds }, mergedSubtitles: r.subtitles }));
      flash('info', '✅ Đã ghép hoàn chỉnh video toàn bộ kịch bản!');
      return true;
    } catch (e) {
      flash('error', `Ghép video thất bại: ${(e as Error).message}`);
    } finally {
      setIsMerging(false);
      setProgress('');
    }
  }, [update, flash]);

  const renderAll = useCallback(
    async (opts: { onlyMissing: boolean; thenMerge: boolean }) => {
      if (isBatch || isMerging) return;
      setIsBatch(true);
      const ids = projectRef.current!.scenes.map(s => s.id);
      for (let i = 0; i < ids.length; i++) {
        const sc = projectRef.current!.scenes.find(s => s.id === ids[i]);
        if (!sc) continue;
        if (opts.onlyMissing && sc.status === 'completed' && sc.video) continue;
        setBatchIndex(i);
        await renderScene(sc.id);
      }
      setIsBatch(false);
      setBatchIndex(null);
      if (opts.thenMerge) await merge();
    },
    [isBatch, isMerging, renderScene, merge]
  );

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
      const copy: SceneItem = { ...t, id: newId('sc'), title: `${t.title} (Bản sao)`, status: 'idle', video: undefined, errorMessage: undefined, lastRender: undefined };
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

  return {
    project,
    models,
    skills,
    ffmpegOk,
    loadError,
    videoModel,
    isAnalyzing,
    isCasting,
    isBatch,
    batchIndex,
    isMerging,
    progress,
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
    renderAll,
    merge,
    addScene,
    duplicateScene,
    deleteScene,
    moveScene,
    addCharacter,
    removeCharacter,
    toggleCharacterInScene,
    toggleSkill,
    reloadSkills,
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
