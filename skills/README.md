# Skill Library

Mỗi file `.md` là một skill: phần YAML front-matter chứa tham số prompt, phần thân là
hướng dẫn đạo diễn được chèn vào bước tách cảnh bằng LLM.

| Trường | Ý nghĩa |
|---|---|
| `id` | định danh (kebab-case) |
| `name`, `description`, `tags` | hiển thị |
| `category` | `style` (hình ảnh) · `genre` (thể loại) · `format` (khung hình/nền tảng) — hoặc tự đặt |
| `promptModifier` | nối vào cuối prompt video của MỌI cảnh |
| `negativePrompt` | gửi cho model hỗ trợ negative prompt |
| `portraitStyle` | phong cách khi vẽ chân dung nhân vật |
| `aspectRatio` | ép tỉ lệ khung (vd `"9:16"`) |
| `defaultCameraAngle` | góc máy mặc định |

Có thể chọn nhiều skill cùng lúc (vd `anime` + `vertical-short` + `educational-dialogue`):
modifier được nối lại, hướng dẫn được gộp. Skill do người dùng tạo (UI / MCP / ACP) lưu ở `skills/user/`.
