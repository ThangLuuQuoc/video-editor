import { useState, type ReactNode } from 'react';
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Cpu, FileText, Loader2, Plus, Sparkles, Trash2, UserPlus, Users, Wand2 } from 'lucide-react';
import { useStudio } from '../studio';
import { SAMPLE_SCRIPT, SCRIPT_MODES } from '../../../src/core/constants';
import type { AspectRatio, ModelInfo, VideoResolution } from '../../../src/core/types';
import { AddCharacterModal, SkillEditorModal } from './Modals';

function Section(props: { icon: ReactNode; title: string; badge?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; last?: boolean }) {
  return (
    <div className={props.last ? '' : 'border-b border-[#242430]'}>
      <div onClick={props.onToggle} className="p-3.5 flex items-center justify-between cursor-pointer hover:bg-[#1a1a24] transition-colors select-none">
        <div className="flex items-center gap-2">
          {props.icon}
          <span className="text-xs font-bold uppercase tracking-wider text-slate-200">{props.title}</span>
        </div>
        <div className="flex items-center gap-2">
          {props.badge}
          {props.open ? <ChevronUp size={15} className="text-slate-400" /> : <ChevronDown size={15} className="text-slate-400" />}
        </div>
      </div>
      {props.open && <div className="px-4 pb-4 pt-1">{props.children}</div>}
    </div>
  );
}

const pill = (color: string) => `text-[10px] font-mono px-2 py-0.5 rounded-full border max-w-[150px] truncate ${color}`;

export function Sidebar() {
  const s = useStudio();
  const p = s.project!;
  const [open, setOpen] = useState({ script: true, cast: true, skills: false, models: false });
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const [showAddChar, setShowAddChar] = useState(false);
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const mode = SCRIPT_MODES.find(m => m.id === p.settings.scriptMode)!;
  const activeSkills = s.skills.filter(sk => p.settings.skillIds.includes(sk.id));
  const categories = [...new Set(s.skills.map(sk => sk.category))];
  const catLabel: Record<string, string> = { style: '🎨 Phong cách hình ảnh (chọn 1)', genre: '🎭 Thể loại', format: '📐 Định dạng / nền tảng' };

  return (
    <aside className="order-2 lg:order-1 flex-1 lg:flex-none w-full lg:w-[390px] xl:w-[420px] bg-[#14141b] border-r border-[#242430] flex flex-col min-h-0 overflow-y-auto shrink-0">
      {/* 1. Script */}
      <Section
        icon={<FileText size={15} className="text-amber-400" />}
        title="1. Kịch bản gốc"
        open={open.script}
        onToggle={() => toggle('script')}
        badge={!open.script && <span className={pill('text-amber-400 bg-amber-500/10 border-amber-500/20')}>{mode.short}</span>}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-slate-400">Nội dung câu chuyện & phân cảnh:</span>
          <button onClick={() => s.update(c => ({ ...c, script: SAMPLE_SCRIPT }))} className="text-[11px] text-slate-400 hover:text-amber-400">
            Mẫu kịch bản
          </button>
        </div>
        <textarea
          value={p.script}
          onChange={e => s.update(c => ({ ...c, script: e.target.value }))}
          placeholder="Dán kịch bản (tiếng Việt / tiếng Anh). Hỗ trợ định dạng: Cảnh 1 (5s): ... / Bối cảnh / Nhân vật / Hành động / Thoại / Âm thanh"
          rows={7}
          className="w-full bg-[#1a1a24] border border-[#2f2f40] focus:border-amber-400 rounded-xl p-3 text-xs text-slate-200 placeholder-slate-500 outline-none resize-y leading-relaxed"
        />
        <div className="mt-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Chế độ kịch bản</div>
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#171722] rounded-xl border border-[#2b2b3b]">
            {SCRIPT_MODES.map(m => (
              <button
                key={m.id}
                onClick={() => s.setSettings({ scriptMode: m.id })}
                title={m.description}
                className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold truncate ${p.settings.scriptMode === m.id ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white'}`}
              >
                {m.short}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-1 italic">{mode.description}</p>
        </div>
        <button
          onClick={s.analyze}
          disabled={s.isAnalyzing || !p.script.trim()}
          className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-semibold bg-[#222230] hover:bg-[#2a2a3c] border border-amber-500/30 text-amber-300 disabled:opacity-60"
        >
          {s.isAnalyzing ? (
            <>
              <Loader2 size={15} className="animate-spin" /> {s.progress || 'Đang phân tích...'}
            </>
          ) : (
            <>
              <Wand2 size={15} /> Phân tích & Tách cảnh ({s.models?.text.find(m => m.id === s.effective('text'))?.label ?? 'AI'})
            </>
          )}
        </button>
      </Section>

      {/* 2. Cast */}
      <Section
        icon={<Users size={15} className="text-cyan-400" />}
        title="2. Nhân vật (@Cast)"
        open={open.cast}
        onToggle={() => toggle('cast')}
        badge={<span className={pill('text-cyan-400 bg-cyan-500/10 border-cyan-500/20')}>{p.characters.length} nhân vật</span>}
      >
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] text-slate-400">Ảnh tham chiếu giữ đồng nhất khuôn mặt & trang phục:</p>
          <button
            onClick={() => setShowAddChar(true)}
            className="flex items-center gap-1 text-[11px] bg-cyan-950/60 hover:bg-cyan-900/80 text-cyan-300 border border-cyan-700/40 px-2 py-1 rounded-lg shrink-0"
          >
            <UserPlus size={13} /> Thêm
          </button>
        </div>
        <label className="mb-3 p-2.5 rounded-xl bg-[#1b1b26] border border-cyan-500/20 flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={p.settings.autoGenerateCharacters}
            onChange={e => s.setSettings({ autoGenerateCharacters: e.target.checked })}
            className="mt-0.5 accent-cyan-400 w-4 h-4"
          />
          <span className="text-xs text-slate-300 leading-snug">
            <span className="font-semibold text-cyan-300 block">Tự động tạo nhân vật sau khi tách cảnh</span>
            <span className="text-[11px] text-slate-400">
              Vẽ chân dung bằng <span className="text-amber-400">{s.models?.image.find(m => m.id === s.effective('image'))?.label}</span>
            </span>
          </span>
        </label>
        {p.characters.length > 0 && (
          <div className="grid grid-cols-2 gap-2 mb-2">
            {p.characters.map(c => (
              <div key={c.id} className="relative group bg-[#191924] border border-[#2d2d3e] hover:border-cyan-500/40 rounded-xl p-2 flex items-center gap-2" title={c.description}>
                {c.image ? (
                  <img src={c.image.url} alt={c.name} className="w-10 h-10 rounded-lg object-cover shrink-0 border border-white/10" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-slate-800 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white truncate">{c.name}</div>
                  <div className="text-[10px] text-cyan-400/90 truncate">{c.description || 'Đã đồng bộ'}</div>
                </div>
                <button
                  onClick={() => s.removeCharacter(c.id)}
                  className="absolute top-1 right-1 p-1 text-slate-500 hover:text-red-400 bg-black/60 rounded opacity-0 group-hover:opacity-100"
                  title="Gỡ nhân vật"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => s.autoCast()}
          disabled={s.isCasting || !p.script.trim()}
          className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-cyan-950/40 hover:bg-cyan-900/60 border border-cyan-500/30 text-cyan-300 text-xs font-semibold disabled:opacity-50"
        >
          {s.isCasting ? (
            <>
              <Loader2 size={13} className="animate-spin" /> {s.progress || 'Đang vẽ chân dung...'}
            </>
          ) : (
            <>
              <Sparkles size={13} /> Vẽ tự động các nhân vật từ kịch bản
            </>
          )}
        </button>
      </Section>

      {/* 3. Skill Library */}
      <Section
        icon={<BookOpen size={15} className="text-fuchsia-400" />}
        title="3. Skill Library"
        open={open.skills}
        onToggle={() => toggle('skills')}
        badge={<span className={pill('text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/20')}>{activeSkills.map(x => x.name.split(' ')[0]).join(' ') || 'không'}</span>}
      >
        <p className="text-[11px] text-slate-400 mb-2">Kết hợp phong cách + thể loại + định dạng. Skill định hướng cả bước tách cảnh lẫn prompt video.</p>
        {categories.map(cat => (
          <div key={cat} className="mb-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">{catLabel[cat] ?? cat}</div>
            <div className="grid grid-cols-1 gap-1.5">
              {s.skills
                .filter(sk => sk.category === cat)
                .map(sk => {
                  const on = p.settings.skillIds.includes(sk.id);
                  return (
                    <button
                      key={sk.id}
                      onClick={() => s.toggleSkill(sk)}
                      title={sk.directives}
                      className={`flex items-center justify-between gap-2 p-2 rounded-xl border text-left transition-all ${
                        on ? 'bg-fuchsia-500/10 border-fuchsia-500/60' : 'bg-[#181822] border-[#292938] hover:border-slate-600'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className={`text-xs font-medium block ${on ? 'text-fuchsia-200' : 'text-slate-300'}`}>
                          {sk.name} {sk.source === 'user' && <span className="text-[9px] text-emerald-400 ml-1">USER</span>}
                        </span>
                        <span className="text-[10px] text-slate-500 block truncate">{sk.description}</span>
                      </span>
                      {on && <CheckCircle2 size={14} className="text-fuchsia-400 shrink-0" />}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        <button
          onClick={() => setShowSkillEditor(true)}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-fuchsia-500/40 text-fuchsia-300 text-xs hover:bg-fuchsia-500/10"
        >
          <Plus size={13} /> Tạo skill mới
        </button>
      </Section>

      {/* 4. Models */}
      <Section
        icon={<Cpu size={15} className="text-emerald-400" />}
        title="4. Mô hình & Xuất hình"
        open={open.models}
        onToggle={() => toggle('models')}
        last
        badge={
          <span className={pill('text-emerald-400 bg-emerald-500/10 border-emerald-500/20')}>
            {s.videoModel?.label ?? '—'} • {p.settings.resolution}
          </span>
        }
      >
        <ModelSelect kind="text" label="Model văn bản (tách cảnh, nhân vật)" />
        <ModelSelect kind="image" label="Model ảnh (chân dung nhân vật)" />
        <div className="text-[11px] text-slate-400 mb-1.5 mt-3">Model video:</div>
        <div className="space-y-1.5 mb-3">
          {s.models!.video.map(m => (
            <VideoModelCard key={m.id} m={m} />
          ))}
        </div>
        <Segmented
          label="Độ phân giải"
          options={['360p', '480p', '720p', '1080p'] as VideoResolution[]}
          value={p.settings.resolution}
          supported={s.videoModel?.resolutions}
          onChange={v => s.setSettings({ resolution: v })}
        />
        <Segmented
          label="Tỉ lệ khung"
          options={['16:9', '9:16', '1:1', '4:3'] as AspectRatio[]}
          value={p.settings.aspectRatio}
          supported={s.videoModel?.aspectRatios}
          onChange={v => s.setSettings({ aspectRatio: v })}
        />
        <p className="text-[10px] text-slate-500 mt-2">
          Thêm model / nhà cung cấp bất kỳ bằng <code className="text-slate-300">ai-video.config.json</code> (OpenAI-compatible, Anthropic, fal.ai, Replicate, MCP server...).
        </p>
      </Section>

      {showAddChar && <AddCharacterModal onClose={() => setShowAddChar(false)} />}
      {showSkillEditor && <SkillEditorModal onClose={() => setShowSkillEditor(false)} />}
    </aside>
  );
}

function ModelSelect({ kind, label }: { kind: 'text' | 'image'; label: string }) {
  const s = useStudio();
  const list = s.models![kind];
  const key = `${kind}Model` as const;
  return (
    <div className="mb-2.5">
      <div className="text-[11px] text-slate-400 mb-1">{label}</div>
      <select
        value={s.effective(kind)}
        onChange={e => s.setSettings({ [key]: e.target.value })}
        className="w-full bg-[#121219] border border-[#2c2c3e] focus:border-emerald-400 text-xs text-slate-200 rounded-xl p-2 outline-none"
      >
        {list.map(m => (
          <option key={m.id} value={m.id} disabled={!m.available}>
            {m.available ? '✅' : '⛔'} {m.label}
            {m.available ? '' : ` — ${m.unavailableReason}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function VideoModelCard({ m }: { m: ModelInfo }) {
  const s = useStudio();
  const selected = s.effective('video') === m.id;
  const dur = m.durations?.length ? `${m.durations.join('/')}s` : `${m.minDuration ?? 2}–${m.maxDuration ?? 20}s`;
  return (
    <button
      disabled={!m.available}
      onClick={() => {
        const patch: Record<string, unknown> = { videoModel: m.id };
        const st = s.project!.settings;
        if (m.resolutions?.length && !m.resolutions.includes(st.resolution)) patch.resolution = m.resolutions[0];
        if (m.aspectRatios?.length && !m.aspectRatios.includes(st.aspectRatio)) patch.aspectRatio = m.aspectRatios[0];
        s.setSettings(patch);
      }}
      title={m.unavailableReason}
      className={`w-full text-left p-2.5 rounded-xl border text-xs transition-all ${
        selected ? 'bg-emerald-500/10 border-emerald-500/60' : 'bg-[#181822] border-[#292938] hover:border-slate-600'
      } ${m.available ? '' : 'opacity-45 cursor-not-allowed'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`font-bold truncate ${selected ? 'text-emerald-400' : 'text-slate-200'}`}>{m.label}</span>
          {m.badge && <span className="text-[9px] px-1.5 rounded bg-slate-800 text-slate-400 border border-slate-700 shrink-0">{m.badge}</span>}
        </span>
        {selected && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
      </div>
      {m.description && <div className="text-[10px] text-slate-400 mt-0.5">{m.description}</div>}
      <div className="flex flex-wrap gap-x-3 text-[10px] text-slate-500 font-mono mt-1">
        <span>{dur}</span>
        {m.resolutions && <span>{m.resolutions.join(',')}</span>}
        <span>ref: {m.maxReferenceImages ?? 0}</span>
        <span>{m.supportsAudio ? '🔊 audio' : '🔇'}</span>
        {m.cost && <span className="text-amber-400/90">{m.cost}</span>}
        {!m.available && <span className="text-red-400">{m.unavailableReason}</span>}
      </div>
    </button>
  );
}

function Segmented<T extends string>(props: { label: string; options: T[]; value: T; supported?: T[]; onChange: (v: T) => void }) {
  return (
    <div className="mb-2">
      <div className="text-[11px] text-slate-400 mb-1">{props.label}</div>
      <div className="grid grid-cols-4 gap-1 p-1 bg-[#171722] rounded-xl border border-[#2b2b3b]">
        {props.options.map(o => {
          const ok = !props.supported?.length || props.supported.includes(o);
          return (
            <button
              key={o}
              disabled={!ok}
              onClick={() => props.onChange(o)}
              className={`py-1 rounded-lg text-[11px] font-semibold ${props.value === o ? 'bg-emerald-500 text-black' : 'text-slate-400 hover:text-white'} disabled:opacity-30`}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}
