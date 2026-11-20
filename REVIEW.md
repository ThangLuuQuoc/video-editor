# Review: Script-to-Video Director (bản Google Flow "Create Tool")

Bản gốc là một component React ~1.500 dòng, chạy bên trong Flow và gọi `flow-sdk`
(`Flow.generate.text/image/video`, `Flow.media.select`, `Flow.download`). Dưới đây là
những điểm đã ghi nhận và cách bản AI-Video xử lý.

## 1. Khóa cứng vào hệ sinh thái Google

| Bản Flow | Hệ quả | AI-Video |
|---|---|---|
| `Flow.generate.*` + tên model cứng (`Omni 1.2 Flash`, `Veo 3.1`, `🍌 Nano Banana 2.1`) | Không chạy được ngoài Flow, không đổi được nhà cung cấp | Lớp `Provider` + `ModelRegistry`; model khai báo trong JSON (OpenAI-compatible, Anthropic, fal.ai, Replicate, MCP server, mock) |
| Quy tắc thời lượng viết trong code (`if (selectedModel.startsWith('Veo')) 8s`) | Thêm model mới phải sửa code | Mỗi model tự khai báo `durations` / `min/maxDuration` / `resolutions` / `aspectRatios`; `snapVideoParams()` dùng chung |
| `Flow.media.select` để chọn ảnh nhân vật | Chỉ dùng được Media Gallery của Flow | Upload file, AI vẽ chân dung, hoặc `imagePath` qua MCP |
| Video giữ dạng base64 trong React state + `URL.createObjectURL` không bao giờ revoke | Tốn RAM (mỗi clip vài MB × 2), rò rỉ bộ nhớ | File lưu trên đĩa (`data/media`), UI chỉ giữ URL; server hỗ trợ HTTP Range để tua video |

## 2. Lỗi logic

1. **State cũ trong luồng async** — `generateVideoForScene` và `handleCreateAllAndMergeVideo` đọc `scenes` từ closure.
   Vòng lặp batch kiểm tra `scene.status` của lần render trước; bước ghép dùng mẹo
   `setScenes(latest => { mergeAll(latest); return latest; })` — gọi side-effect bên trong updater
   (React StrictMode gọi updater 2 lần → ghép 2 lần). AI-Video dùng `projectRef` cập nhật đồng bộ.
   (Khi thử nghiệm, chính lỗi loại này đã làm video ghép thiếu cảnh cuối trước khi được sửa.)
2. **Fallback "nhân vật đầu tiên"** — cảnh không khớp tên nào vẫn bị gắn `characters[0]` → cảnh phong
   cảnh không người vẫn gửi ảnh tham chiếu của nhân vật chính. Đã bỏ.
3. **So khớp tên bằng `includes` hai chiều** — "An" khớp "Lan", "Anh", "Bác chủ quán" khớp mọi câu có
   chữ "bác". Thay bằng so khớp nguyên từ Unicode (`mentions()`), cộng nhận diện người nói `Tên: "..."`.
4. **Bóc JSON mong manh** — chỉ xử lý trường hợp bắt đầu bằng ```` ```json ````; LLM thêm một câu dẫn là
   `JSON.parse` lỗi. `extractJson()` tìm mảng/đối tượng đầu tiên, sửa dấu phẩy thừa.
5. **Parser dự phòng** — `split(/(?:Cảnh|Scene)\s*(\d+)/)` lệch chỉ số khi có văn bản trước "Cảnh 1",
   và dồn cả khối (bối cảnh, hành động...) vào `dialogue`. Thay bằng parser theo dòng hiểu các trường
   Bối cảnh / Nhân vật / Hành động / Thoại / Âm thanh (VI + EN).
6. **Ghép video bằng MediaRecorder trên canvas** — chạy theo thời gian thực (phim 2 phút = chờ 2 phút),
   phụ thuộc tab đang mở, blob luôn gán `video/mp4` kể cả khi trình duyệt ghi WebM, và phụ đề hiển thị
   **toàn bộ** lời thoại suốt cả cảnh. AI-Video ghép bằng ffmpeg phía server (chuẩn hóa kích thước/fps/
   âm thanh, concat không nén lại), phụ đề **canh thời gian theo từng câu**, xuất thêm `.vtt`.
7. **Trình phát Full Movie** — vừa gán `src` qua prop React vừa set `videoRef.current.src` thủ công;
   `fullMovieIndex` không reset khi danh sách cảnh hoàn tất thay đổi. Đã chuyển sang điều khiển hoàn toàn bằng state.
8. **Prompt lời thoại cho model không có tiếng** — luôn chèn "Spoken Dialogue: ..." vào prompt; với model
   câm điều này hay sinh chữ lạ trên hình. Nay chỉ chèn khi model `supportsAudio`.
9. Nhỏ: `autoGenerateCastFromScript(currentScenes)` không dùng tham số; xóa cảnh không dọn
   `collapsedSceneIds`; dữ liệu mẫu nạp qua `useEffect` thay vì state ban đầu; `select-none` ở gốc
   chặn bôi đen thông báo lỗi để copy.

## 3. Điểm tốt được giữ lại

Luồng UX (kịch bản → cảnh → nhân vật → render → ghép), 3 chế độ kịch bản (strict / educational /
cinematic), prompt tách cảnh giữ nguyên văn lời thoại, timeline thu gọn/nhảy nhanh, trình phát nối
cảnh có CC — tất cả được port sang AI-Video.
