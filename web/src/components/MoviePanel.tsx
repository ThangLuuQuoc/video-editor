import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Download, Film, Layers, Loader2, MessageSquare, Pause, Play, SkipBack, SkipForward, Square, Video } from 'lucide-react';
import { useStudio } from '../studio';
import { SyncedVideo } from './SyncedVideo';

/** Sequential playlist player + merged-file card. */
export function MoviePanel() {
  const s = useStudio();
  const p = s.project!;
  const [collapsed, setCollapsed] = useState(true);
  const [cc, setCc] = useState(true);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const list = p.scenes.filter(sc => sc.status === 'completed' && sc.video);
  const safeIndex = list.length ? Math.min(index, list.length - 1) : 0;
  const current = list[safeIndex];

  // Auto-expand once a merge result appears.
  const mergedFile = p.merged?.file;
  useEffect(() => {
    if (mergedFile) setCollapsed(false);
  }, [mergedFile]);

  // Keep playing when the clip changes (src is driven by state only, not set imperatively).
  useEffect(() => {
    if (playing) videoRef.current?.play().catch(() => setPlaying(false));
  }, [current?.video?.file]);

  const go = (delta: number) => {
    if (!list.length) return;
    setIndex((safeIndex + delta + list.length) % list.length);
    setPlaying(true);
  };
  const onEnded = () => {
    if (safeIndex < list.length - 1) go(1);
    else setPlaying(false);
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  return (
    <div className="shrink-0 bg-[#13131c] border-b border-[#252536]">
      <div className="p-3 lg:px-5 flex flex-wrap items-center justify-between gap-2.5 bg-[#171724]">
        <button onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-2 text-left">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
            <Film size={17} />
          </div>
          <span className="font-display text-base sm:text-lg text-amber-400">XEM & XUẤT VIDEO HOÀN CHỈNH</span>
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
            {list.length}/{p.scenes.length} cảnh sẵn sàng
          </span>
        </button>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <>
              <button
                onClick={() => setCc(!cc)}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold border ${
                  cc ? 'bg-amber-500/20 text-amber-300 border-amber-500/50' : 'bg-[#1c1c28] text-slate-400 border-slate-700'
                }`}
              >
                <MessageSquare size={13} /> CC: {cc ? 'BẬT' : 'TẮT'}
              </button>
              <label className="hidden sm:flex items-center gap-1.5 text-xs text-slate-300 bg-[#1c1c28] px-2.5 py-1.5 rounded-xl border border-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={p.settings.burnInSubtitles}
                  onChange={e => s.setSettings({ burnInSubtitles: e.target.checked })}
                  className="accent-amber-500 w-3.5 h-3.5"
                />
                In phụ đề vào video
                {!s.subtitlesOk && (
                  <span title="ffmpeg trên máy thiếu libass (filter subtitles) — không in được chữ vào video, chỉ có file .vtt">
                    <AlertTriangle size={13} className="text-red-400" />
                  </span>
                )}
              </label>
            </>
          )}
          {s.mergeJob ? (
            <button
              onClick={() => s.cancelJob(s.mergeJob!.id)}
              className="flex items-center gap-1.5 bg-red-500/10 text-red-300 border border-red-500/40 text-xs font-semibold px-2.5 py-1.5 rounded-xl"
            >
              <Square size={11} className="fill-current" /> Dừng ghép
            </button>
          ) : (
            <button
              onClick={() => s.merge()}
              disabled={s.isMerging || s.isBatch || list.length === 0}
              className="flex items-center gap-1.5 bg-[#252538] hover:bg-[#2f2f46] text-amber-300 border border-amber-500/40 text-xs font-semibold px-2.5 py-1.5 rounded-xl disabled:opacity-40"
            >
              {s.isMerging ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Ghép ngay
            </button>
          )}
          <button onClick={() => setCollapsed(!collapsed)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#252536]">
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>

      {s.mergeJob && (
        <div className="px-4 py-2 bg-amber-500/10 border-y border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> {s.mergeJob.progress}
        </div>
      )}
      {!collapsed && p.mergeWarnings && p.mergeWarnings.length > 0 && (
        <div className="px-4 py-2 bg-red-500/5 border-y border-red-500/20 text-red-300 text-[11px] space-y-0.5">
          {p.mergeWarnings.map(w => (
            <div key={w} className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {w}
            </div>
          ))}
        </div>
      )}

      {!collapsed && (
        <div className="p-4 lg:p-5 pt-3 grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 xl:col-span-8 bg-black rounded-2xl overflow-hidden border border-[#2d2d40] relative flex items-center justify-center h-[240px] xl:h-[300px]">
            {current ? (
              <>
                <SyncedVideo
                  ref={videoRef}
                  key={current.video!.file}
                  src={current.video!.url}
                  voice={s.voiceState(current) === 'not-needed' ? undefined : current.voice}
                  className="w-full h-full object-contain"
                  onEnded={onEnded}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
                {cc && current.dialogue && (
                  <div className="absolute bottom-11 left-3 right-3 text-center pointer-events-none">
                    <div className="inline-block max-w-[92%] bg-black/85 border border-amber-400/40 rounded-xl px-3 py-1.5">
                      <p className="text-xs sm:text-sm font-bold text-amber-200 leading-relaxed line-clamp-2 whitespace-pre-line">{current.dialogue}</p>
                    </div>
                  </div>
                )}
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-lg bg-black/70 text-[10px] text-amber-300 border border-white/10 font-mono">
                  Cảnh {current.sceneNumber} ({safeIndex + 1}/{list.length}): {current.title}
                </div>
                <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between bg-black/75 px-2.5 py-1 rounded-xl border border-white/10 text-xs">
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => go(-1)} className="p-1 hover:text-amber-400 text-slate-300">
                      <SkipBack size={14} />
                    </button>
                    <button onClick={toggle} className="p-1 rounded-full bg-amber-500 hover:bg-amber-400 text-black">
                      {playing ? <Pause size={12} /> : <Play size={12} className="fill-current" />}
                    </button>
                    <button onClick={() => go(1)} className="p-1 hover:text-amber-400 text-slate-300">
                      <SkipForward size={14} />
                    </button>
                    <span className="text-[10px] text-slate-400 ml-1 hidden sm:inline">Tự động nối cảnh</span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">{current.lastRender ? `${current.lastRender.model} · ${current.lastRender.resolution}` : ''}</span>
                </div>
              </>
            ) : (
              <div className="text-center p-4 space-y-1.5">
                <Film size={28} className="mx-auto text-slate-600" />
                <p className="text-xs font-semibold text-slate-400">Chưa có phân cảnh nào được render</p>
                <p className="text-[11px] text-slate-500">Bấm "🎬 Tạo tất cả & Ghép 1 Video" để quay và xem toàn bộ kịch bản.</p>
              </div>
            )}
          </div>

          <div className="lg:col-span-5 xl:col-span-4 flex flex-col justify-between bg-[#171724] border border-[#2d2d40] rounded-2xl p-3.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-1.5">
                  <CheckCircle2 size={14} className="text-emerald-400" /> File video ghép
                </span>
                {p.merged?.durationSeconds && <span className="text-[10px] text-emerald-400 font-mono">{p.merged.durationSeconds}s</span>}
              </div>
              {p.merged ? (
                <video src={p.merged.url} controls playsInline className="w-full aspect-video max-h-[170px] rounded-xl bg-black border border-white/10">
                  {p.mergedSubtitles && <track kind="subtitles" src={p.mergedSubtitles.url} srcLang="vi" label="Thoại" />}
                </video>
              ) : (
                <div className="border border-dashed border-[#2d2d42] rounded-xl p-3 text-center bg-[#12121a]">
                  <Video size={20} className="mx-auto text-slate-600 mb-1" />
                  <div className="text-xs font-semibold text-slate-400">Chưa xuất video ghép</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Ghép bằng ffmpeg trên server: MP4 H.264, lồng tiếng TTS khi model không có tiếng, phụ đề khớp từng câu thoại</div>
                </div>
              )}
            </div>
            <div className="mt-3 pt-2.5 border-t border-[#262638] flex gap-2">
              {p.merged ? (
                <>
                  <a
                    href={p.merged.url}
                    download={`${p.name.replace(/[^\p{L}\p{N}]+/gu, '_')}.mp4`}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-black text-xs font-bold"
                  >
                    <Download size={13} /> Tải MP4
                  </a>
                  {p.mergedSubtitles && (
                    <a href={p.mergedSubtitles.url} download="phude.vtt" className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#222234] border border-slate-700 text-slate-300 text-xs">
                      Phụ đề .vtt
                    </a>
                  )}
                </>
              ) : (
                <button
                  onClick={() => s.merge()}
                  disabled={s.isMerging || s.isBatch || list.length === 0}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[#222234] border border-amber-500/30 text-amber-300 text-xs font-semibold disabled:opacity-40"
                >
                  <Layers size={13} /> Ghép tất cả cảnh thành 1 file MP4
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
