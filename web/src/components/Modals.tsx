import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Film, FolderOpen, Loader2, Plus, Sparkles, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { useStudio } from '../studio';
import { api } from '../api';
import { SAMPLE_SCRIPT } from '../../../src/core/constants';

function Modal({ title, subtitle, icon, onClose, children, wide }: { title: string; subtitle?: string; icon: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`bg-[#181824] border border-[#2e2e42] rounded-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto p-6 shadow-2xl relative`}>
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-[#252536]">
          <X size={18} />
        </button>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">{icon}</div>
          <div>
            <h3 className="text-base font-bold text-white">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const input = 'w-full bg-[#12121a] border border-[#2d2d40] focus:border-cyan-400 text-xs text-slate-200 rounded-xl p-2.5 outline-none';

export function AddCharacterModal({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const [tab, setTab] = useState<'upload' | 'ai'>('upload');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) return setError('Hãy nhập tên nhân vật (trùng tên trong kịch bản để tự gắn vào cảnh)');
    setBusy(true);
    setError('');
    try {
      if (tab === 'upload') {
        if (!file) throw new Error('Chọn một ảnh chân dung');
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        s.addCharacter(await api.uploadCharacter({ name: name.trim(), description, dataUrl }));
      } else {
        const p = s.project!;
        s.addCharacter(
          await api.portrait({ spec: { name: name.trim(), description, imagePrompt: imagePrompt || undefined }, skillIds: p.settings.skillIds, imageModel: s.effective('image') })
        );
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Thêm nhân vật" subtitle="Ảnh tham chiếu giúp giữ khuôn mặt nhất quán giữa các cảnh" icon={<UserPlus size={20} />} onClose={onClose}>
      <div className="grid grid-cols-2 gap-1 p-1 bg-[#12121a] rounded-xl border border-[#2b2b3b] mb-4">
        {(['upload', 'ai'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`py-1.5 rounded-lg text-xs font-semibold ${tab === t ? 'bg-cyan-500 text-black' : 'text-slate-400'}`}>
            {t === 'upload' ? '📁 Tải ảnh lên' : '✨ AI vẽ chân dung'}
          </button>
        ))}
      </div>
      <div className="space-y-3 mb-5">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên nhân vật (vd: Mai, Bác chủ quán)" className={input} />
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Vai diễn / mô tả ngắn" className={input} />
        {tab === 'upload' ? (
          <label className="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-[#2f2f42] hover:border-cyan-500/50 rounded-xl p-4 cursor-pointer text-xs text-slate-400">
            <Upload size={18} className="text-cyan-400" />
            {file ? file.name : 'Chọn ảnh PNG / JPG / WEBP'}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
        ) : (
          <textarea
            value={imagePrompt}
            onChange={e => setImagePrompt(e.target.value)}
            rows={3}
            placeholder="Mô tả ngoại hình (tiếng Anh tốt nhất): young Vietnamese woman, short bob hair, denim jacket..."
            className={input}
          />
        )}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white">
          Hủy
        </button>
        <button onClick={submit} disabled={busy} className="flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-bold px-4 py-2 rounded-xl disabled:opacity-60">
          {busy ? <Loader2 size={15} className="animate-spin" /> : tab === 'upload' ? <Upload size={15} /> : <Sparkles size={15} />}
          {tab === 'upload' ? 'Thêm nhân vật' : 'Vẽ & thêm'}
        </button>
      </div>
    </Modal>
  );
}

export function SkillEditorModal({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const [f, setF] = useState({ id: '', name: '', category: 'style', description: '', promptModifier: '', negativePrompt: '', portraitStyle: '', aspectRatio: '', directives: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const userSkills = s.skills.filter(x => x.source === 'user');

  const save = async () => {
    try {
      await api.saveSkill({ ...f, tags: [], aspectRatio: (f.aspectRatio || undefined) as any } as any);
      await s.reloadSkills();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Tạo skill mới" subtitle="Lưu vào skills/user/<id>.md — dùng được cả từ MCP & ACP" icon={<BookOpen size={20} />} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={f.id} onChange={set('id')} placeholder="id (vd: wes-anderson)" className={input} />
        <input value={f.name} onChange={set('name')} placeholder="Tên hiển thị (vd: 🎨 Wes Anderson)" className={input} />
        <select value={f.category} onChange={set('category')} className={input}>
          <option value="style">style — phong cách hình ảnh</option>
          <option value="genre">genre — thể loại</option>
          <option value="format">format — định dạng / nền tảng</option>
        </select>
        <select value={f.aspectRatio} onChange={set('aspectRatio')} className={input}>
          <option value="">Tỉ lệ khung: không ép</option>
          {['16:9', '9:16', '1:1', '4:3'].map(a => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <input value={f.description} onChange={set('description')} placeholder="Mô tả ngắn" className={input} />
        <textarea value={f.promptModifier} onChange={set('promptModifier')} rows={2} placeholder="promptModifier — nối vào cuối mọi prompt video (tiếng Anh)" className={input} />
        <input value={f.negativePrompt} onChange={set('negativePrompt')} placeholder="negativePrompt (tùy chọn)" className={input} />
        <input value={f.portraitStyle} onChange={set('portraitStyle')} placeholder="portraitStyle — phong cách vẽ chân dung nhân vật (tùy chọn)" className={input} />
        <textarea
          value={f.directives}
          onChange={set('directives')}
          rows={5}
          placeholder={'Hướng dẫn đạo diễn (markdown) cho bước tách cảnh, vd:\n- Bố cục đối xứng, máy quay cố định chính diện\n- Bảng màu pastel'}
          className={input}
        />
      </div>
      {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
      {userSkills.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Skill của bạn</div>
          {userSkills.map(sk => (
            <div key={sk.id} className="flex items-center justify-between text-xs text-slate-300 py-1">
              <span>
                {sk.name} <span className="text-slate-500">({sk.id})</span>
              </span>
              <button
                onClick={async () => {
                  await api.deleteSkill(sk.id);
                  await s.reloadSkills();
                }}
                className="text-slate-500 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-3 mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white">
          Hủy
        </button>
        <button onClick={save} className="flex items-center gap-2 bg-fuchsia-500 hover:bg-fuchsia-400 text-black text-xs font-bold px-4 py-2 rounded-xl">
          <Plus size={15} /> Lưu skill
        </button>
      </div>
    </Modal>
  );
}

export function ProjectsModal({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const [list, setList] = useState<{ id: string; name: string; updatedAt: string; scenes: number }[] | null>(null);
  const load = () => api.listProjects().then(setList);
  useEffect(() => {
    load();
  }, []);
  const open = async (id?: string) => {
    if (id) await s.openProject(id);
    else {
      const p = await api.createProject({ name: 'Dự án mới', script: SAMPLE_SCRIPT });
      await s.openProject(p.id);
    }
    onClose();
  };
  return (
    <Modal title="Dự án" subtitle="Dùng chung với MCP & ACP (lưu trong data/projects)" icon={<FolderOpen size={20} />} onClose={onClose}>
      <button onClick={() => open()} className="w-full mb-3 flex items-center justify-center gap-2 py-2 rounded-xl bg-amber-500 text-black text-xs font-bold">
        <Plus size={14} /> Dự án mới
      </button>
      {!list ? (
        <Loader2 className="animate-spin mx-auto text-slate-500" />
      ) : (
        <div className="space-y-1.5">
          {list.map(p => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-2 p-2.5 rounded-xl border text-xs ${p.id === s.project?.id ? 'border-amber-500/60 bg-amber-500/10' : 'border-[#2a2a3a] hover:border-slate-600'}`}
            >
              <button onClick={() => open(p.id)} className="text-left min-w-0 flex-1">
                <div className="text-slate-200 font-semibold truncate">{p.name}</div>
                <div className="text-[10px] text-slate-500">
                  {p.scenes} cảnh · {new Date(p.updatedAt).toLocaleString('vi-VN')}
                </div>
              </button>
              {p.id !== s.project?.id && (
                <button
                  onClick={async () => {
                    await api.deleteProject(p.id);
                    load();
                  }}
                  className="text-slate-500 hover:text-red-400"
                  title="Xóa dự án"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function IntroModal({ onClose }: { onClose: () => void }) {
  const steps = [
    ['Nhập kịch bản & tách cảnh', 'Dán kịch bản VI/EN. Model văn bản bất kỳ (Claude, GPT, Gemini, Ollama, OpenRouter… hoặc bộ tách theo luật offline) chia thành cảnh, giữ nguyên lời thoại.'],
    ['Nhân vật nhất quán', 'Tải ảnh lên hoặc để AI vẽ chân dung; ảnh được gửi làm tham chiếu cho model video hỗ trợ reference.'],
    ['Skill Library', 'Kết hợp phong cách + thể loại + định dạng. Mỗi skill là một file .md, có thể tự tạo.'],
    ['Render & ghép', 'Chọn model video (Kling, Veo, Seedance, Hailuo, Sora, MCP server riêng, hoặc mock miễn phí). ffmpeg ghép thành 1 MP4 có phụ đề.'],
    ['MCP & ACP', 'Điều khiển toàn bộ quy trình từ Claude / IDE: "npm run mcp" (MCP server) hoặc "npm run acp" (agent cho Zed…).']
  ];
  return (
    <Modal title="AI Video Director" subtitle="Script-to-Video đa mô hình, không phụ thuộc hệ sinh thái nào" icon={<Film size={22} />} onClose={onClose}>
      <div className="space-y-3 text-xs text-slate-300 leading-relaxed mb-6">
        {steps.map(([t, d], i) => (
          <div key={t} className="flex gap-2.5">
            <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-[11px] shrink-0">{i + 1}</span>
            <p>
              <strong className="text-white">{t}:</strong> {d}
            </p>
          </div>
        ))}
      </div>
      <button onClick={onClose} className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-black font-bold py-2.5 rounded-xl text-xs">
        Bắt đầu chỉ đạo phân cảnh
      </button>
    </Modal>
  );
}
