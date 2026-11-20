import { useEffect, useState } from 'react';
import { AlertCircle, Clock, Film, FolderOpen, Info, Layers, Loader2, PanelLeft, PanelLeftClose, Square, X } from 'lucide-react';
import { StudioProvider, useStudio } from './studio';
import { Sidebar } from './components/Sidebar';
import { MoviePanel } from './components/MoviePanel';
import { SceneList } from './components/SceneList';
import { IntroModal, ProjectsModal } from './components/Modals';

export function App() {
  return (
    <StudioProvider>
      <Studio />
    </StudioProvider>
  );
}

function Studio() {
  const s = useStudio();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showIntro, setShowIntro] = useState(false);
  const [showProjects, setShowProjects] = useState(false);

  useEffect(() => {
    if (s.project) document.title = `${s.project.name} · AI Video Director`;
  }, [s.project?.name]);

  if (s.loadError)
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-2">
          <AlertCircle className="mx-auto text-red-400" />
          <p className="text-sm text-slate-200">Không kết nối được API server: {s.loadError}</p>
          <p className="text-xs text-slate-400">Chạy <code className="text-amber-300">npm run dev</code> trong thư mục AI-Video.</p>
        </div>
      </div>
    );
  if (!s.project || !s.models)
    return (
      <div className="h-full flex items-center justify-center text-slate-400 gap-2 text-sm">
        <Loader2 className="animate-spin" size={18} /> Đang tải studio...
      </div>
    );

  const p = s.project;
  const totalDuration = p.scenes.reduce((a, sc) => a + (sc.durationSeconds || 0), 0);
  const done = p.scenes.filter(sc => sc.status === 'completed').length;

  return (
    <div className="flex flex-col h-full w-full bg-[#101014] text-slate-100 font-sans overflow-hidden">
      <header className="shrink-0 h-16 border-b border-[#272732] bg-[#14141a] px-3 lg:px-6 flex items-center justify-between gap-3 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={`p-2 rounded-xl border transition-all ${sidebarOpen ? 'bg-[#1e1e2c] border-slate-700 text-slate-300 hover:text-white' : 'bg-amber-500/20 border-amber-500/50 text-amber-300'}`}
            title={sidebarOpen ? 'Thu gọn cột trái' : 'Mở cột kịch bản'}
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
          </button>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-600 to-amber-400 hidden sm:flex items-center justify-center text-black shrink-0">
            <Film size={22} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-display text-xl text-white hidden md:inline">AI VIDEO DIRECTOR</span>
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hidden md:inline">
                Đa mô hình · MCP · ACP
              </span>
            </div>
            <input
              value={p.name}
              onChange={e => s.update(cur => ({ ...cur, name: e.target.value }))}
              className="bg-transparent text-xs text-slate-400 hover:text-slate-200 focus:text-white outline-none w-28 sm:w-56 truncate"
              title="Tên dự án"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden lg:flex items-center gap-4 bg-[#1b1b24] px-3.5 py-1.5 rounded-lg border border-[#2d2d3a] text-xs">
            <span className="flex items-center gap-1.5 text-slate-300">
              <Clock size={14} className="text-amber-400" /> Tổng: <b className="font-mono text-amber-400">{totalDuration}s</b>
            </span>
            <span className="flex items-center gap-1.5 text-slate-300">
              <Layers size={14} className="text-cyan-400" /> Tiến độ:{' '}
              <b className="font-mono text-cyan-400">
                {done}/{p.scenes.length}
              </b>
            </span>
          </div>
          <button onClick={() => setShowProjects(true)} className="p-2 text-slate-400 hover:text-white hover:bg-[#252532] rounded-lg" title="Dự án">
            <FolderOpen size={18} />
          </button>
          <button onClick={() => setShowIntro(true)} className="p-2 text-slate-400 hover:text-white hover:bg-[#252532] rounded-lg" title="Hướng dẫn">
            <Info size={18} />
          </button>
          {s.isBatch || s.mergeJob ? (
            <div className="flex items-center gap-1.5">
              <span
                className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold bg-amber-500/20 text-amber-200 border border-amber-500/40 max-w-[46vw] sm:max-w-[340px]"
                title={(s.batchJob ?? s.mergeJob)?.progress}
              >
                <Loader2 size={16} className="animate-spin shrink-0" />
                <span className="truncate">
                  {s.isMerging ? 'Đang ghép...' : `Đang quay cảnh ${s.batchIndex !== null ? s.batchIndex + 1 : ''}/${p.scenes.length}...`}
                </span>
              </span>
              <button
                onClick={() => s.cancelJob((s.batchJob ?? s.mergeJob)!.id)}
                disabled={/hủy/i.test((s.batchJob ?? s.mergeJob)!.progress)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs sm:text-sm font-bold bg-red-500/15 text-red-300 border border-red-500/50 hover:bg-red-500/25 disabled:opacity-50"
                title="Dừng tác vụ (hủy cả request đang chạy ở nhà cung cấp nếu hỗ trợ)"
              >
                <Square size={13} className="fill-current" /> <span className="hidden sm:inline">Dừng</span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => s.renderAll({ onlyMissing: true, thenMerge: true })}
              disabled={p.scenes.length === 0}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all bg-gradient-to-r from-amber-500 via-amber-400 to-amber-600 text-black hover:brightness-110 active:scale-95 disabled:opacity-40"
            >
              <Film size={16} /> <span className="hidden lg:inline">🎬 Tạo tất cả & Ghép 1 Video</span>
              <span className="lg:hidden">Tạo & Ghép</span>
            </button>
          )}
        </div>
      </header>

      {s.notice && (
        <div
          className={`shrink-0 px-4 py-2 text-xs flex items-center justify-between gap-2 border-b ${
            s.notice.kind === 'error'
              ? 'bg-red-500/10 text-red-300 border-red-500/30'
              : s.notice.kind === 'warn'
                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
          }`}
        >
          <span>{s.notice.text}</span>
          <button onClick={() => s.setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {(s.isBatch || s.mergeJob) && (
        <div className="shrink-0 px-4 py-1.5 text-[11px] bg-amber-500/5 text-amber-300/90 border-b border-amber-500/20 flex items-center gap-2 truncate">
          <Loader2 size={12} className="animate-spin shrink-0" /> <span className="truncate">{(s.batchJob ?? s.mergeJob)!.progress}</span>
          <span className="hidden md:inline text-slate-500 shrink-0">· chạy trên server, có thể đóng tab và mở lại</span>
        </div>
      )}
      {!s.ffmpegOk && (
        <div className="shrink-0 px-4 py-2 text-xs bg-red-500/10 text-red-300 border-b border-red-500/30">
          ⚠ Không tìm thấy ffmpeg — chức năng ghép video và model mock sẽ không chạy. Cài ffmpeg hoặc đặt FFMPEG_PATH trong .env.
        </div>
      )}

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
        {sidebarOpen && <Sidebar />}
        <main className="order-1 lg:order-2 flex-1 min-h-0 bg-[#0f0f14] flex flex-col overflow-hidden">
          <MoviePanel />
          <SceneList />
        </main>
      </div>

      {showIntro && <IntroModal onClose={() => setShowIntro(false)} />}
      {showProjects && <ProjectsModal onClose={() => setShowProjects(false)} />}
    </div>
  );
}
