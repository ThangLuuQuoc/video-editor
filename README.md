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
  providers/        openai · anthropic · fal · replicate · mcp · mock
  registry.ts       chọn model, kiểm tra khả dụng (thiếu key…)
  pipeline.ts       tách cảnh, nhân vật, dựng prompt, render cảnh
  merge.ts          ghép ffmpeg + phụ đề theo câu thoại
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
| `openai` | text, image, video (Sora) | Mọi API tương thích OpenAI: OpenAI, OpenRouter, Gemini, DeepSeek, Groq, Ollama, LM Studio, vLLM |
| `anthropic` | text | Claude (Messages API) |
| `fal` | image, video | Một adapter cho mọi model trên fal.ai — body lấy từ template `input` |
| `replicate` | text, image, video | `model` = `owner/name` hoặc `owner/name:version` |
| `mcp` | text, image, video | Gọi tool của **bất kỳ MCP server nào** làm backend sinh ảnh/video |
| `mock` | text, image, video | Offline, miễn phí |

**Template `input`**: chuỗi đúng bằng `"{{x}}"` giữ nguyên kiểu (số, mảng…); `"{{x|str}}"` ép chuỗi;
`"{{duration}}s"` nội suy; khóa có giá trị rỗng bị bỏ. Biến có sẵn: `prompt`, `negative_prompt`,
`duration`, `resolution`, `aspect_ratio`, `image` (ảnh tham chiếu đầu tiên, data URI), `images`
(mảng), `generate_audio`. `referenceModel` + `referenceInput` dùng khi cảnh có ảnh nhân vật (ví dụ
endpoint image-to-video). `output` là đường dẫn tới URL media trong phản hồi (vd `video.url`, `output[0]`).

> Các template fal/Replicate/Sora trong cấu hình mặc định viết theo tài liệu công khai của từng nhà
> cung cấp và **chưa được chạy thử với key thật** trong lần dựng này — schema của nhà cung cấp có thể
> đổi; nếu lỗi, chỉnh `input`/`output` trong `ai-video.config.json` mà không cần sửa code.

## Skill Library

Mỗi skill là một file Markdown với front-matter YAML — xem [skills/README.md](skills/README.md).
Có sẵn 12 skill: 6 phong cách (cinematic, anime, realistic-4k, cyberpunk, animation-3d, vintage-35mm),
5 thể loại (educational-dialogue, product-ad, music-video, documentary, horror) và 1 định dạng
(vertical-short 9:16). Kết hợp tự do; tạo skill mới từ web, MCP (`create_skill`) hoặc thả file vào
`skills/user/`.

## MCP server

Tool: `make_video` (1 bước từ kịch bản → MP4), `create_project`, `update_project`, `analyze_script`,
`auto_cast`, `add_character`, `update_scene`, `render_scene`, `render_all`, `merge_video`,
`get_project`, `list_projects`, `list_models`, `list_skills`, `get_skill`, `create_skill`.
Resource: `skill://<id>`. Bước dài gửi `notifications/progress` nếu client có progressToken.

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
/model video <id> /mode <strict|educational|cinematic> /set resolution|aspect|subtitles|autocast`.

## Kiểm thử

```powershell
npm run typecheck
npx tsx scripts/smoke.ts     # chạy MCP make_video + phiên ACP đầy đủ bằng model mock
```
