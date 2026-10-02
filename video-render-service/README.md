# Video Render Service

FastAPI backend ghép video + phụ đề + nhạc nền bằng FFmpeg. Chạy Cloud Run (không database, không Cloud Storage).

**Tính năng:**
- Quét thư mục Drive, cắt & ghép theo kịch bản, chuyển cảnh mượt (crossfade)
- Burn phụ đề với cỡ chữ tự co theo khung hình, 6 hiệu ứng chữ
- Text bìa đầu video + nhạc nền (fade in/out, lặp, ducking)

**Cách dùng:** POST `/api/jobs` với fields: `video_folder_url`, `clips` (JSON/gọn), `srt_text`, `intro_text`, `music_url`, `options`.
Xem `docs/SPEC.md` cho chi tiết đầy đủ.

## Cắt & ghép

```json
{"video_edit_script": [{"source_video": "a.mp4", "start": "00:00", "end": "00:04"}],
 "video_srt": "1\n00:00:00,000 --> 00:00:05,000\nChữ\n"}
```

Hoặc gọn: `1 00:00-00:04`

## Hiệu ứng

- **Transition:** `options.transition = {"duration": 0.8, "style": "wipeleft"}` (default: crossfade)
- **Text:** `options.subtitle.effect = fade|pop|slide_up|typewriter|glow` (default: fade)
- **Intro:** `intro_text` hiện tích tắc làm bìa video, dùng `|` xuống dòng

## Setup

```bash
make install && cp .env.example .env  # sửa API_KEY
make dev                              # local: :8080
make build && make run-docker         # hoặc Docker
```

## Deploy

```bash
echo -n "$(openssl rand -hex 32)" | gcloud secrets create video-render-api-key --data-file=-
PROJECT_ID=my-project REGION=asia-southeast1 make deploy
```

Share thư mục Drive cho service account (script in ra ở cuối).

## Giới hạn (design constraints)

- 1 instance → job state trong RAM → không scale ngang
- Job mất khi restart → client phải poll & gửi lại
- `/tmp` là RAM → tổng file ≤ ~60% memory
- Upload ≤ 32 MiB (giới hạn Cloud Run) → dùng Drive link cho video lớn
- Output hết TTL (1h default) nếu không download/upload lên Drive
