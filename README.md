# AI Video Director

Script-to-Video đa mô hình — viết lại từ "Script-to-Video Director" của Google Flow, **không phụ thuộc
hệ sinh thái nào**. Dán kịch bản → AI tách cảnh → tạo nhân vật nhất quán → render từng cảnh bằng model
video bạn chọn → ghép thành 1 MP4 có phụ đề.

Điều khiển được theo 3 cách: **giao diện web**, **MCP server** (Claude Desktop/Code, Cursor…) và
**ACP agent** (Zed, JetBrains, Neovim…). Phong cách video mở rộng qua **Skill Library**.

Xem [REVIEW.md](REVIEW.md) để biết các vấn đề trong bản Flow gốc và cách đã xử lý.

## Chạy nhanh

Yêu cầu: Node 20+ (khuyên 22+), ffmpeg trong PATH (để ghép video và chạy model mock).

```powershell
cd AI-Video
npm install
copy .env.example .env    # điền API key của nhà cung cấp bạn dùng (có thể bỏ trống để test offline)
npm run dev               # API :8787 + web :5173  →  mở http://localhost:5173
```

Bản production: `npm run build` rồi `npm start` → http://localhost:8787.

Không có API key nào? Vẫn chạy được trọn vẹn với **model mock**: tách cảnh theo luật, avatar SVG,
clip giả lập bằng ffmpeg — để thử quy trình mà không tốn credit.

Dòng lệnh: `npm run make -- kichban.txt kling-2.1 anime,vertical-short` → in ra đường dẫn MP4.

## Kiến trúc

```
src/core/           lõi dùng chung (không phụ thuộc giao diện)
  providers/        openai · anthropic · fal · replicate · mcp · system (TTS hệ điều hành) · mock
  registry.ts       chọn model, kiểm tra khả dụng (thiếu key…), giọng TTS
  pipeline.ts       tách cảnh, nhân vật, ảnh tham chiếu (sheet / keyframe), prompt, render cảnh
  voicePlan.ts      gán giọng theo nhân vật (thuần, dùng chung với web)
  voice.ts          lồng tiếng đa giọng cho từng cảnh (TTS + ffmpeg)
  merge.ts          ghép ffmpeg: mux giọng, giữ khung cuối nếu thoại dài, phụ đề theo câu
  jobs.ts           job nền có hủy (AbortController)
  skills.ts         Skill Library (file .md)
  director.ts       thao tác theo dự án (dùng cho MCP / ACP / CLI)
src/server/
  http.ts           REST API + phục vụ web + /media (hỗ trợ Range)
  mcp.ts            MCP server (stdio, SDK chính thức)
  acp.ts            ACP agent (stdio, JSON-RPC)
web/                giao diện React (port từ bản Flow)
skills/             thư viện skill có sẵn; skills/user/ = skill bạn tạo
config/default.config.json   nhà cung cấp + danh mục model
```

Dự án lưu ở `data/projects/*.json`, media ở `data/media/` — **dùng chung** giữa web, MCP và ACP
(tạo bằng Claude qua MCP rồi mở tiếp trên web qua `webUrl` trả về).

## Thêm / đổi model

Tạo `ai-video.config.json` ở thư mục gốc (được gộp đè lên `config/default.config.json`, model cùng `id`
sẽ được ghi đè). `${TEN_BIEN}` lấy từ biến môi trường / `.env`.

```jsonc
{
  "providers": {
    "lmstudio": { "type": "openai", "baseUrl": "http://localhost:1234/v1", "noKey": true },
    "my-mcp":   { "type": "mcp", "command": "npx", "args": ["-y", "some-video-mcp-server"], "env": { "API_KEY": "${MY_KEY}" } }
  },
  "models": {
    "text":  [{ "id": "qwen-local", "label": "Qwen (LM Studio)", "provider": "lmstudio", "model": "qwen2.5-14b-instruct" }],
    "video": [{
      "id": "wan-fal", "label": "Wan (fal)", "provider": "fal",
      "model": "fal-ai/wan/v2.2-a14b/text-to-video",
      "input": { "prompt": "{{prompt}}", "aspect_ratio": "{{aspect_ratio}}", "resolution": "{{resolution}}" },
      "output": "video.url", "durations": [5], "resolutions": ["480p", "720p"]
    }, {
      "id": "mcp-video", "provider": "my-mcp", "model": "generate_video",
      "input": { "prompt": "{{prompt}}", "seconds": "{{duration}}", "image": "{{image}}" }
    }]
  },
  "defaults": { "text": "qwen-local", "video": "wan-fal" }
}
```

| Loại provider | Dùng cho | Ghi chú |
|---|---|---|
| `openai` | text, image, video (Sora), tts | Mọi API tương thích OpenAI: OpenAI, OpenRouter, Gemini, DeepSeek, Groq, Ollama, LM Studio, vLLM |
| `anthropic` | text | Claude (Messages API) |
| `fal` | image, video, tts | Một adapter cho mọi model trên fal.ai — body lấy từ template `input` |
| `replicate` | text, image, video | `model` = `owner/name` hoặc `owner/name:version` |
| `mcp` | text, image, video | Gọi tool của **bất kỳ MCP server nào** làm backend sinh ảnh/video |
| `system` | tts | Giọng của hệ điều hành (SAPI / say / espeak-ng), tự liệt kê giọng |
| `mock` | text, image, video, tts | Offline, miễn phí |

**Template `input`**: chuỗi đúng bằng `"{{x}}"` giữ nguyên kiểu (số, mảng…); `"{{x|str}}"` ép chuỗi;
`"{{duration}}s"` nội suy; khóa có giá trị rỗng bị bỏ. Biến có sẵn: `prompt`, `negative_prompt`,
`duration`, `resolution`, `aspect_ratio`, `image` (ảnh tham chiếu đầu tiên — URL fal/Replicate sau khi
upload, hoặc data URI), `images` (mảng), `generate_audio`; model TTS: `text`, `voice`, `speed`. `referenceModel` + `referenceInput` dùng khi cảnh có ảnh nhân vật; khai báo
`referenceMode: "first-frame"` nếu endpoint đó dùng ảnh làm khung hình đầu (image-to-video). `output` là đường dẫn tới URL media trong phản hồi (vd `video.url`, `output[0]`).

> Các template fal/Replicate/Sora trong cấu hình mặc định viết theo tài liệu công khai của từng nhà
> cung cấp và **chưa được chạy thử với key thật** trong lần dựng này — schema của nhà cung cấp có thể
> đổi; nếu lỗi, chỉnh `input`/`output` trong `ai-video.config.json` mà không cần sửa code.

## Lồng tiếng đa giọng (TTS)

Model video không có tiếng (Kling, Seedance, Hailuo, mock…) vẫn có thoại: ở chế độ **Tự động**, sau khi
render, mỗi câu `Tên: "câu nói"` được đọc bằng giọng riêng của nhân vật đó rồi ghép vào cảnh.

- **Chọn giọng**: tự động theo tuổi / giới tính đoán từ tên + mô tả + prompt chân dung (bà/ông/grandma →
  lớn tuổi, cháu/bé/boy → trẻ em…), mỗi nhân vật một giọng khác nhau; chọn tay ở cột trái mục
  *Lồng tiếng* (có nút ▶ nghe thử). Câu không ghi người nói → giọng của nhân vật duy nhất trong cảnh,
  hoặc giọng *Lời dẫn*.
- **Model TTS**: ElevenLabs Multilingual v2 (fal, `FAL_KEY`), OpenAI `gpt-4o-mini-tts` (tự thêm chỉ dẫn
  diễn xuất: tuổi, cảm xúc, nói chậm ở chế độ học thoại), Kokoro (fal, rẻ), **giọng hệ điều hành**
  (Windows SAPI / macOS `say` / Linux `espeak-ng` — miễn phí, offline) và mock (tiếng bíp để thử nhịp).
- **Thời gian**: phụ đề `.vtt` và phụ đề in vào video canh theo **thời lượng thật** của từng câu đọc.
  Thoại dài hơn clip thì khung hình cuối được giữ lại tới khi đọc xong; âm thanh gốc của clip được giảm nhỏ.
- **Chế độ**: Tự động (chỉ khi model video câm) · Luôn lồng tiếng · Tắt. Sửa thoại/giọng → cảnh báo
  "giọng đã cũ" và bước ghép tự tạo lại giọng (rẻ hơn nhiều so với render lại video).

## Nhân vật nhất quán khi model nhận ít ảnh

| Model | Cách gửi ảnh nhân vật |
|---|---|
| Nhận ảnh làm **tham chiếu nhân vật** (`referenceMode: "subject"`: Veo 3.1 reference-to-video, Seedance, MiniMax subject) | Gửi trực tiếp; nếu cảnh có nhiều nhân vật hơn số ảnh model nhận → **ghép các chân dung thành 1 ảnh** (character sheet, ffmpeg `hstack`) và prompt nói rõ ai ở trái/phải |
| Dùng ảnh làm **khung hình đầu** (`referenceMode: "first-frame"`: Kling/Hailuo/Veo 3 image-to-video, Sora) | Gửi chân dung thẳng vào sẽ khiến video mở đầu bằng tấm chân dung, nên app **dựng khung hình đầu (keyframe)** bằng model ảnh nhận nhiều ảnh (Nano Banana edit, gpt-image) đặt các nhân vật vào bối cảnh, rồi mới image-to-video. Không có model ảnh phù hợp → render chỉ bằng mô tả chữ và ghi chú lại |

**Veo 3.1 Fast** (`veo31-fast`) là lựa chọn hợp nhất cho hội thoại nhiều nhân vật: vừa có tiếng nói/lip-sync,
vừa nhận tới 3 ảnh nhân vật. Ảnh tham chiếu được **upload lên fal storage** (hoặc Replicate Files API)
để gửi URL ngắn thay vì base64 trong JSON.

## Chạy nền, dừng, đồng bộ

- Render 1 cảnh / render hàng loạt / lồng tiếng / ghép đều là **job trên server** chạy trên dự án đã lưu —
  đóng tab hoặc F5 không làm đứt; mở lại trang sẽ tự bắt lại job đang chạy.
- Nút **⏹ Dừng** (header, từng cảnh, ghép) hủy job: dừng ffmpeg, hủy request ở fal/Replicate để không
  bị tính tiền tiếp; cảnh đang render dở trở về trạng thái cũ.
- Web, MCP và ACP dùng chung file dự án: kết quả render ghi bởi server không bị autosave của web ghi đè
  (gộp theo `renderRev`/`mergeRev`), thay đổi từ MCP hiện lên web sau vài giây.
- Nếu ffmpeg thiếu `libass`, app cảnh báo ngay ở ô "In phụ đề vào video" và sau khi ghép (phụ đề vẫn có ở `.vtt`).
- **Dọn media thừa**: hộp thoại *Dự án* → "Dọn file media thừa" (xem trước số file/dung lượng rồi mới xóa)
  hoặc MCP `cleanup_media`. File mới hơn 1 giờ luôn được giữ.

## Skill Library

Mỗi skill là một file Markdown với front-matter YAML — xem [skills/README.md](skills/README.md).
Có sẵn 12 skill: 6 phong cách (cinematic, anime, realistic-4k, cyberpunk, animation-3d, vintage-35mm),
5 thể loại (educational-dialogue, product-ad, music-video, documentary, horror) và 1 định dạng
(vertical-short 9:16). Kết hợp tự do; tạo skill mới từ web, MCP (`create_skill`) hoặc thả file vào
`skills/user/`.

## MCP server

Tool: `make_video` (1 bước từ kịch bản → MP4), `create_project`, `update_project`, `analyze_script`,
`auto_cast`, `add_character`, `update_scene`, `render_scene`, `voice_scene`, `set_character_voice`,
`render_all`, `merge_video`, `cleanup_media`, `get_project`, `list_projects`, `list_models` (gồm model TTS
và danh sách giọng), `list_skills`, `get_skill`, `create_skill`.
Resource: `skill://<id>`. Bước dài gửi `notifications/progress` nếu client có progressToken; client hủy
request (`notifications/cancelled`) thì render cũng dừng.

Claude Code:

```powershell
claude mcp add ai-video -- node D:/Projects/ClaudeDemo/AI-Video/node_modules/tsx/dist/cli.mjs D:/Projects/ClaudeDemo/AI-Video/src/cli.ts mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-video": {
      "command": "node",
      "args": ["D:/Projects/ClaudeDemo/AI-Video/node_modules/tsx/dist/cli.mjs", "D:/Projects/ClaudeDemo/AI-Video/src/cli.ts", "mcp"]
    }
  }
}
```

## ACP agent

Zed (`settings.json`):

```json
{
  "agent_servers": {
    "AI Video Director": {
      "command": "node",
      "args": ["D:/Projects/ClaudeDemo/AI-Video/node_modules/tsx/dist/cli.mjs", "D:/Projects/ClaudeDemo/AI-Video/src/cli.ts", "acp"]
    }
  }
}
```

Trong khung chat: dán kịch bản (hoặc @đính kèm file) → agent tự chạy cả quy trình, hiển thị từng bước
như tool call. Trước khi render bằng model trả phí, agent xin phép qua `session/request_permission`.
Lệnh: `/help /new /script /analyze /cast /render [n] /merge /make /status /skills [ids] /models
/model <text|image|video|tts> <id> /mode <strict|educational|cinematic> /set resolution|aspect|subtitles|autocast|voice`.
`session/cancel` dừng cả bước render/ghép đang chạy.

## Kiểm thử

```powershell
npm run typecheck
npx tsx scripts/smoke.ts     # chạy MCP make_video + phiên ACP đầy đủ bằng model mock
```
