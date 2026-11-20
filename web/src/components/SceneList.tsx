import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  User,
  Video,
  Volume2,
  Wand2
} from 'lucide-react';
import { useStudio, type VoiceState } from '../studio';
import { SyncedVideo } from './SyncedVideo';
import { parseDialogueLines } from '../../../src/core/voicePlan';
import { api } from '../api';
import { CAMERA_ANGLES } from '../../../src/core/constants';
import type { CameraAngle, ModelInfo, SceneItem } from '../../../src/core/types';

function snapDuration(m: ModelInfo | undefined, d: number): number {
  if (!m) return d;
  if (m.durations?.length) return m.durations.reduce((b, c) => (Math.abs(c - d) < Math.abs(b - d) ? c : b));
  return Math.min(Math.max(d, m.minDuration ?? 2), m.maxDuration ?? 20);
}

export function SceneList() {
  const s = useStudio();
  const p = s.project!;
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const allCollapsed = p.scenes.length > 0 && p.scenes.every(sc => collapsed.includes(sc.id));

  return (
    <>
      <div className="shrink-0 bg-[#16161f] border-b border-[#252532] px-4 lg:px-6 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-lg text-slate-200">TIMELINE PHÂN CẢNH ({p.scenes.length})</span>
            <span className="text-xs text-slate-400 truncate">
              • <span className="text-emerald-400 font-semibold">{s.videoModel?.label}</span> ({p.settings.resolution}, {p.settings.aspectRatio})
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCollapsed(allCollapsed ? [] : p.scenes.map(sc => sc.id))}
              className="flex items-center gap-1.5 bg-[#20202d] hover:bg-[#28283a] border border-slate-700 text-xs text-slate-300 px-2.5 py-1.5 rounded-xl"
            >
              {allCollapsed ? <ChevronsDown size={14} className="text-cyan-400" /> : <ChevronsUp size={14} className="text-amber-400" />}
              {allCollapsed ? 'Mở rộng tất cả' : 'Thu gọn tất cả'}
            </button>
            <button
              onClick={() => s.renderAll({ onlyMissing: false, thenMerge: false })}
              disabled={s.isBatch || !!s.mergeJob || p.scenes.length === 0}
              className="hidden sm:flex items-center gap-1.5 bg-[#232330] hover:bg-[#2c2c3e] border border-slate-700 text-xs text-slate-200 px-3 py-1.5 rounded-xl disabled:opacity-40"
            >
              <RotateCcw size={13} className="text-amber-400" /> Render lại tất cả
            </button>
            <button onClick={s.addScene} className="flex items-center gap-1.5 bg-[#232330] hover:bg-[#2c2c3e] border border-slate-700 text-xs text-slate-200 px-3 py-1.5 rounded-xl">
              <Plus size={14} className="text-amber-400" /> Thêm cảnh
            </button>
          </div>
        </div>
        {p.scenes.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 shrink-0 mr-1">Nhảy nhanh:</span>
            {p.scenes.map(sc => (
              <button
                key={sc.id}
                onClick={() => document.getElementById(`scene-${sc.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] shrink-0 bg-[#191924] hover:bg-[#252536] border border-[#2b2b3d] text-slate-300"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    sc.status === 'completed' ? 'bg-emerald-400' : sc.status === 'generating' ? 'bg-amber-400 animate-pulse' : sc.status === 'error' ? 'bg-red-400' : 'bg-slate-600'
                  }`}
                />
                Cảnh {sc.sceneNumber}
                <span className="text-[10px] text-slate-500 font-mono">({sc.durationSeconds}s)</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 lg:p-6 space-y-3.5">
        {p.scenes.length === 0 && (
          <div className="border-2 border-dashed border-[#2a2a3a] rounded-2xl p-10 text-center">
            <Wand2 className="mx-auto text-amber-400 mb-2" />
            <p className="text-sm text-slate-300 font-semibold">Chưa có phân cảnh</p>
            <p className="text-xs text-slate-500 mt-1 mb-3">Dán kịch bản ở cột trái rồi bấm "Phân tích & Tách cảnh", hoặc thêm cảnh thủ công.</p>
            <button
              onClick={s.analyze}
              disabled={s.isAnalyzing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 text-black text-xs font-bold disabled:opacity-50"
            >
              {s.isAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Phân tích kịch bản
            </button>
          </div>
        )}
        {p.scenes.map((sc, i) => (
          <SceneCard
            key={sc.id}
            scene={sc}
            index={i}
            collapsed={collapsed.includes(sc.id)}
            onCollapse={c => setCollapsed(prev => (c ? [...prev, sc.id] : prev.filter(x => x !== sc.id)))}
          />
        ))}
      </div>
    </>
  );
}

const VOICE_BADGE: Record<VoiceState, [string, string]> = {
  none: ['', ''],
  'not-needed': ['Model video tự tạo tiếng — không cần lồng tiếng', 'text-slate-500'],
  missing: ['Chưa lồng tiếng', 'text-slate-400'],
  stale: ['Giọng đã cũ (thoại/giọng thay đổi)', 'text-amber-400'],
  ok: ['Đã lồng tiếng', 'text-emerald-400']
};

/** Who speaks each line with which voice + (re)generate the scene's voice track. */
function VoiceRow({ scene, state, voicing }: { scene: SceneItem; state: VoiceState; voicing: boolean }) {
  const s = useStudio();
  const p = s.project!;
  if (state === 'none' || p.settings.voiceMode === 'off') return null;
  const speakers = [...new Set(parseDialogueLines(scene.dialogue).map(l => l.speaker ?? ''))];
  const voiceOf = (name: string) => {
    const c = name ? p.characters.find(x => x.name.toLowerCase() === name.toLowerCase()) : undefined;
    const id = c ? s.castVoices[c.id] : undefined;
    return id ? s.voices.find(v => v.id === id)?.label ?? id : null;
  };
  const [label, color] = VOICE_BADGE[state];
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px]">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
        <span className={`flex items-center gap-1 font-semibold ${color}`}>
          <Volume2 size={11} /> {label}
          {scene.voice && state !== 'not-needed' && <span className="font-mono text-slate-500">· {scene.voice.durationSeconds}s</span>}
        </span>
        {state !== 'not-needed' &&
          speakers.map(n => {
            const v = voiceOf(n);
            return (
              <span key={n || '-'} className="text-slate-500 truncate max-w-[180px]">
                {n || 'Lời dẫn'}
                {v ? ` → ${v}` : ''}
              </span>
            );
          })}
      </span>
      {state !== 'not-needed' && (
        <button
          onClick={() => s.voiceScene(scene.id)}
          disabled={voicing || !s.ttsModel?.available}
          title={!s.ttsModel?.available ? `Model TTS chưa sẵn sàng: ${s.ttsModel?.unavailableReason ?? ''}` : undefined}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-cyan-500/40 text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-40"
        >
          {voicing ? <Loader2 size={10} className="animate-spin" /> : <Volume2 size={10} />}
          {state === 'missing' ? 'Lồng tiếng' : 'Tạo lại giọng'}
        </button>
      )}
    </div>
  );
}

function SceneCard({ scene, index, collapsed, onCollapse }: { scene: SceneItem; index: number; collapsed: boolean; onCollapse: (c: boolean) => void }) {
  const s = useStudio();
  const p = s.project!;
  const [showDetails, setShowDetails] = useState(false);
  const [finalPrompt, setFinalPrompt] = useState<string | null>(null);
  const generating = scene.status === 'generating';
  const job = s.jobForScene(scene.id) ?? (generating ? s.batchJob : undefined);
  const vstate = s.voiceState(scene);
  const voicing = s.jobs.some(j => j.kind === 'voice' && j.sceneId === scene.id);
  const bound = p.characters.filter(c => scene.selectedCharacterIds.includes(c.id));
  const snapped = snapDuration(s.videoModel, scene.durationSeconds);
  const refLimit = s.videoModel?.maxReferenceImages ?? 0;
  const set = (patch: Partial<SceneItem>) => s.patchScene(scene.id, patch);
  const badge = `SCENE ${String(scene.sceneNumber).padStart(2, '0')}`;
  const fileName = `Canh_${scene.sceneNumber}_${scene.title.replace(/[^\p{L}\p{N}]+/gu, '_')}.mp4`;

  const previewPrompt = async () => {
    try {
      const r = await api.scenePrompt({ scene, characters: p.characters, settings: { ...p.settings, videoModel: s.effective('video') } });
      const refs: Record<string, string> = {
        none: 'không gửi ảnh nhân vật',
        direct: 'gửi trực tiếp ảnh nhân vật',
        sheet: 'ghép nhiều chân dung thành 1 ảnh tham chiếu',
        keyframe: 'dựng khung hình đầu bằng model ảnh rồi image-to-video'
      };
      setFinalPrompt(
        r.prompt +
          (r.negativePrompt ? `\n\nNEGATIVE: ${r.negativePrompt}` : '') +
          `\n\nẢNH THAM CHIẾU: ${refs[r.references] ?? r.references}` +
          (r.notes.length ? `\n⚠ ${r.notes.join('\n⚠ ')}` : '')
      );
    } catch (e) {
      setFinalPrompt(`Lỗi: ${(e as Error).message}`);
    }
  };

  const RenderButton = ({ small }: { small?: boolean }) => (
    <button
      onClick={() => s.renderScene(scene.id)}
      disabled={generating || s.isBatch}
      className={
        small
          ? 'flex items-center gap-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs px-2.5 py-1 rounded-lg border border-amber-500/30 font-semibold'
          : 'flex items-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-black text-xs font-bold px-4 py-2 rounded-xl active:scale-95'
      }
    >
      <Sparkles size={small ? 12 : 14} /> {small ? 'Tạo video' : 'Tạo video cho cảnh này'}
    </button>
  );

  return (
    <div
      id={`scene-${scene.id}`}
      className={`bg-[#171722] border rounded-2xl shadow-lg scroll-mt-6 ${
        generating ? 'border-amber-500 ring-1 ring-amber-500/30' : scene.status === 'completed' ? 'border-emerald-500/40' : scene.status === 'error' ? 'border-red-500/40' : 'border-[#292938]'
      }`}
    >
      {collapsed ? (
        <div className="p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button onClick={() => onCollapse(false)} className="font-display text-sm text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20 shrink-0">
              {badge}
            </button>
            <div className="flex flex-col min-w-0">
              <span className="flex items-center gap-2">
                <span className="font-bold text-xs text-white truncate max-w-[260px]">{scene.title}</span>
                <span className="font-mono text-[10px] text-amber-400/90 bg-amber-500/10 px-1.5 rounded border border-amber-500/20">{scene.durationSeconds}s</span>
              </span>
              <span className="text-[11px] text-amber-200/80 italic truncate max-w-lg">{scene.dialogue ? `💬 ${scene.dialogue.replace(/\n/g, ' / ')}` : scene.promptDescription}</span>
            </div>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              {bound.map(c => c.image && <img key={c.id} src={c.image.url} title={c.name} className="w-5 h-5 rounded-full object-cover border border-cyan-400/60" />)}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {scene.video ? (
              <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
                <CheckCircle2 size={13} /> Hoàn tất
              </span>
            ) : generating ? (
              <span className="flex items-center gap-1.5 text-amber-400 text-xs">
                <Loader2 size={13} className="animate-spin" /> Đang render...
              </span>
            ) : (
              <RenderButton small />
            )}
            <button onClick={() => onCollapse(false)} className="p-1.5 text-slate-400 hover:text-white rounded-lg">
              <ChevronDown size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#262636]">
            <div className="flex items-center gap-2.5">
              <button onClick={() => onCollapse(true)} className="font-display text-base text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-md border border-amber-500/20" title="Thu gọn">
                {badge}
              </button>
              <input
                value={scene.title}
                onChange={e => set({ title: e.target.value })}
                className="bg-transparent font-bold text-sm text-white focus:bg-[#20202e] px-2 py-0.5 rounded border border-transparent focus:border-amber-400/40 outline-none w-48 sm:w-72"
              />
            </div>
            <div className="flex items-center gap-1 text-slate-400">
              <button onClick={() => s.moveScene(index, -1)} disabled={index === 0} className="p-1.5 hover:text-white disabled:opacity-30 rounded-lg" title="Lên">
                <ChevronUp size={15} />
              </button>
              <button onClick={() => s.moveScene(index, 1)} disabled={index === p.scenes.length - 1} className="p-1.5 hover:text-white disabled:opacity-30 rounded-lg" title="Xuống">
                <ChevronDown size={15} />
              </button>
              <button onClick={() => s.duplicateScene(index)} className="p-1.5 hover:text-white rounded-lg" title="Nhân đôi">
                <Copy size={15} />
              </button>
              <button onClick={() => s.deleteScene(index)} disabled={p.scenes.length <= 1} className="p-1.5 hover:text-red-400 disabled:opacity-30 rounded-lg" title="Xóa">
                <Trash2 size={15} />
              </button>
              <button onClick={() => onCollapse(true)} className="p-1.5 hover:text-amber-400 rounded-lg ml-1 border-l border-slate-700 pl-2" title="Thu gọn">
                <ChevronsUp size={15} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mt-3">
            <div className="lg:col-span-7 space-y-3">
              <div className="bg-[#14141d] p-3 rounded-xl border border-amber-500/30">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                    <MessageSquare size={13} /> Lời thoại trong cảnh
                  </label>
                  <span className="text-[10px] text-amber-400/90 font-mono">
                    {s.videoModel?.supportsAudio === false
                      ? p.settings.voiceMode === 'off'
                        ? '🔇 model không có tiếng · lồng tiếng đang tắt'
                        : '🔇 model không có tiếng → lồng tiếng TTS'
                      : p.settings.voiceMode === 'always'
                        ? 'lip-sync + lồng tiếng TTS'
                        : 'Nguyên văn kịch bản · lip-sync'}
                  </span>
                </div>
                <textarea
                  value={scene.dialogue}
                  onChange={e => set({ dialogue: e.target.value })}
                  rows={2}
                  className="w-full bg-[#0d0d12] border border-[#2e2e42] focus:border-amber-400 rounded-lg p-2 text-xs text-amber-200 placeholder-slate-600 outline-none resize-y"
                  placeholder={`Mai: "Xin chào!"\nTom: "Hello Grandma!"`}
                />
                <VoiceRow scene={scene} state={vstate} voicing={voicing} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <User size={13} className="text-cyan-400" /> Nhân vật trong cảnh
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {scene.characterNames.length > 0 && `Kịch bản: ${scene.characterNames.join(', ')} · `}
                    {refLimit === 0
                      ? 'model không nhận ảnh tham chiếu'
                      : s.videoModel?.referenceMode === 'first-frame'
                        ? 'ảnh → khung hình đầu (keyframe)'
                        : `model nhận tối đa ${refLimit} ảnh${bound.length > refLimit ? ' → sẽ ghép ảnh' : ''}`}
                  </span>
                </div>
                {p.characters.length ? (
                  <div className="flex flex-wrap gap-2">
                    {p.characters.map(c => {
                      const on = scene.selectedCharacterIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          onClick={() => s.toggleCharacterInScene(scene.id, c.id)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                            on ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-300 font-semibold' : 'bg-[#121219] border-[#29293a] text-slate-400 hover:border-slate-500'
                          }`}
                        >
                          {c.image && <img src={c.image.url} className="w-4 h-4 rounded-full object-cover" />}
                          {c.name}
                          {on ? <CheckCircle2 size={12} /> : <Plus size={12} />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 italic bg-[#121219] p-2 rounded-lg border border-[#232332]">
                    Chưa có nhân vật. Model sẽ tự hình dung nhân vật từ mô tả văn bản.
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1">Góc máy</label>
                  <select
                    value={scene.cameraAngle}
                    onChange={e => set({ cameraAngle: e.target.value as CameraAngle })}
                    className="w-full bg-[#121219] border border-[#2c2c3e] focus:border-amber-400 text-xs text-slate-200 rounded-xl p-2 outline-none"
                  >
                    {CAMERA_ANGLES.map(a => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Thời lượng</label>
                    <span className="font-mono text-xs font-bold text-amber-400">
                      {scene.durationSeconds}s{snapped !== scene.durationSeconds && <span className="text-slate-500 font-normal"> → model: {snapped}s</span>}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={20}
                    value={scene.durationSeconds}
                    onChange={e => set({ durationSeconds: Number(e.target.value) })}
                    className="w-full accent-amber-500"
                  />
                </div>
              </div>

              <div className="border border-[#262638] rounded-xl overflow-hidden bg-[#13131c]">
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="w-full flex items-center justify-between p-2.5 text-xs text-slate-300 hover:text-white bg-[#161622]"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FileText size={13} className="text-cyan-400 shrink-0" />
                    <span className="font-semibold shrink-0">Prompt hình ảnh & âm thanh</span>
                    {!showDetails && <span className="text-[10px] text-slate-500 truncate">• {scene.promptDescription}</span>}
                  </span>
                  {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                {showDetails && (
                  <div className="p-3 space-y-3 border-t border-[#262638] bg-[#101017]">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Mô tả hình ảnh (AI prompt)</label>
                      <textarea
                        value={scene.promptDescription}
                        onChange={e => set({ promptDescription: e.target.value })}
                        rows={3}
                        className="mt-1 w-full bg-[#14141e] border border-[#2c2c3e] focus:border-amber-400/50 rounded-xl p-2.5 text-xs text-slate-200 outline-none resize-y"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
                        <Volume2 size={12} /> Chỉ dẫn giọng đọc / âm thanh
                      </label>
                      <input
                        value={scene.audioDirection}
                        onChange={e => set({ audioDirection: e.target.value })}
                        className="mt-1 w-full bg-[#0d0d12] border border-[#2b2b3d] focus:border-cyan-400 rounded-lg p-2 text-xs text-cyan-200 outline-none"
                      />
                    </div>
                    <button onClick={previewPrompt} className="flex items-center gap-1.5 text-[11px] text-slate-300 hover:text-white">
                      <Eye size={13} /> Xem prompt cuối cùng gửi tới model (đã gộp skill + nhân vật)
                    </button>
                    {finalPrompt && <pre className="text-[11px] text-slate-300 whitespace-pre-wrap bg-black/40 p-2 rounded-lg border border-[#262638] select-text">{finalPrompt}</pre>}
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 flex flex-col justify-between bg-[#121219] rounded-xl border border-[#262636] p-3">
              {scene.video && !generating ? (
                <div className="flex flex-col gap-2">
                  <SyncedVideo
                    key={scene.video.file}
                    src={scene.video.url}
                    voice={vstate === 'ok' || vstate === 'stale' ? scene.voice : undefined}
                    controls
                    className="w-full aspect-video rounded-lg bg-black border border-white/5"
                  />
                  {scene.lastRender?.keyframe && (
                    <a href={scene.lastRender.keyframe.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[10px] text-slate-400 hover:text-slate-200">
                      <img src={scene.lastRender.keyframe.url} className="w-12 h-7 object-cover rounded border border-white/10" /> Khung hình đầu (keyframe) dựng từ ảnh nhân vật
                    </a>
                  )}
                  {scene.lastRender?.notes?.map(n => (
                    <div key={n} className="text-[10px] text-amber-300/90 flex items-start gap-1">
                      <AlertCircle size={11} className="shrink-0 mt-0.5" /> {n}
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1.5">
                      <CheckCircle2 size={14} /> {scene.lastRender ? `${scene.lastRender.model} · ${scene.lastRender.durationSeconds}s` : 'Hoàn tất'}
                    </span>
                    <div className="flex items-center gap-2">
                      <a href={scene.video.url} download={fileName} className="flex items-center gap-1 text-[11px] bg-[#1e1e2c] text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700">
                        <Download size={13} /> MP4
                      </a>
                      <button
                        onClick={() => s.renderScene(scene.id)}
                        disabled={s.isBatch}
                        className="flex items-center gap-1 text-[11px] bg-amber-500/20 text-amber-300 px-2.5 py-1 rounded-lg border border-amber-500/40 disabled:opacity-40"
                      >
                        <RotateCcw size={13} /> Tạo lại
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-center h-full min-h-[160px] p-4 gap-2.5">
                  {generating ? (
                    <>
                      <Loader2 size={32} className="animate-spin text-amber-400" />
                      <div className="text-xs font-semibold text-amber-300">Đang render cảnh {scene.sceneNumber}...</div>
                      <p className="text-[11px] text-slate-400">
                        {s.videoModel?.label} ({p.settings.resolution}, {snapped}s)
                      </p>
                      {job && <p className="text-[10px] text-slate-500 max-w-full truncate">{job.progress}</p>}
                      {job && (
                        <button
                          onClick={() => s.cancelJob(job.id)}
                          className="flex items-center gap-1.5 text-[11px] bg-red-500/10 text-red-300 px-3 py-1 rounded-lg border border-red-500/40 hover:bg-red-500/20"
                        >
                          <Square size={10} className="fill-current" /> {job.kind === 'render-all' ? 'Dừng cả loạt' : 'Hủy render'}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="w-12 h-12 rounded-2xl bg-[#1c1c28] border border-[#2f2f42] flex items-center justify-center text-slate-400">
                        <Video size={22} />
                      </div>
                      {scene.status === 'error' && (
                        <div className="text-[11px] text-red-400 flex items-start gap-1 max-w-full break-words select-text">
                          <AlertCircle size={13} className="shrink-0 mt-0.5" /> {scene.errorMessage}
                        </div>
                      )}
                      <RenderButton />
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
