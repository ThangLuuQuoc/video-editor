import type { CameraAngle, ProjectSettings, ScriptMode } from './types';

export const CAMERA_ANGLES: CameraAngle[] = [
  'Wide Shot (Toàn cảnh)',
  'Medium Shot (Trung cảnh)',
  'Close-up (Cận cảnh)',
  'Tracking Shot (Bám theo)',
  'Drone Aerial (Góc cao)',
  'Low Angle (Góc ngước lên)',
  'Over-the-shoulder (Qua vai)'
];

export const SCRIPT_MODES: { id: ScriptMode; label: string; short: string; description: string }[] = [
  {
    id: 'strict',
    label: '🎯 Bám sát kịch bản 100%',
    short: '🎯 Bám sát 100%',
    description: 'Bảo toàn nguyên văn 100% từng câu thoại, cấu trúc cảnh và thời lượng gốc trong kịch bản.'
  },
  {
    id: 'educational',
    label: '🎓 Học ngoại ngữ & Hội thoại',
    short: '🎓 Học thoại',
    description: 'Tối ưu cho hội thoại ngoại ngữ: phát âm chậm, rõ ràng từng chữ, khẩu hình môi chuẩn xác.'
  },
  {
    id: 'cinematic',
    label: '🎬 Sáng tạo điện ảnh tự do',
    short: '🎬 Tự do',
    description: 'Nhấn mạnh góc máy nghệ thuật, nhịp phim điện ảnh và hiệu ứng hình ảnh sống động.'
  }
];

export const DEFAULT_SETTINGS: ProjectSettings = {
  scriptMode: 'strict',
  skillIds: ['cinematic'],
  textModel: '',
  imageModel: '',
  videoModel: '',
  resolution: '720p',
  aspectRatio: '16:9',
  burnInSubtitles: true,
  autoGenerateCharacters: true
};

export const SAMPLE_SCRIPT = `Cảnh 1 (5s): Dạo bước phố cổ hoàng hôn
Bối cảnh: Phố cổ Hà Nội dưới ánh hoàng hôn vàng rực.
Nhân vật: Mai
Hành động: Mai (nữ họa sĩ áo denim) thong thả bước đi trên phố rêu phong, tay cầm cuốn sổ phác thảo.
Thoại: "Hà Nội mùa này đẹp quá, ánh hoàng hôn thật dịu êm!"
Âm thanh: Giọng Mai ấm áp, trong trẻo, tiếng bước chân nhẹ nhàng trên đá cổ.
Cảnh 2 (6s): Mưa rào & Lời chào quán quen
Bối cảnh: Mái hiên tiệm cà phê cổ kính, mưa mùa hạ rào rào.
Nhân vật: Mai, Bác chủ quán
Hành động: Mai nép vào mái hiên, bác chủ quán tóc bạc mỉm cười đón khách.
Thoại:
Mai: "Cháu chào bác! Cho cháu trú mưa một lát nhé ạ."
Bác chủ quán: "Vào đây kẻo ướt cháu ơi, uống ngụm trà nóng này!"
Âm thanh: Tiếng mưa rơi lộp độp, giọng đối đáp tự nhiên, ấm cúng và rõ ràng.
Cảnh 3 (5s): Phác thảo bên song cửa
Bối cảnh: Bên trong quán cà phê ấm cúng nhìn ra khung cửa kính đọng nước mưa.
Nhân vật: Mai
Hành động: Mai mỉm cười, mở cuốn sổ và bắt đầu đặt bút vẽ phố phường lung linh sau màn mưa.
Thoại: "Những hạt mưa làm phố phường trở nên thơ mộng hơn bao giờ hết."
Âm thanh: Tiếng ngòi bút chì sột soạt, nhạc nền acoustic du dương.`;

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
