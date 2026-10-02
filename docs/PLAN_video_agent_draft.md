# Video Agent (Cloud Run mới) — Phân tích video + 2 luồng xử lý render

> [!NOTE]
> Đây là bản chốt kiến trúc trước khi code, tiếp nối `discussion_video_pipeline.md`.
>
> **Cập nhật:** Cả 2 phía đã code xong theo đúng thiết kế dưới đây.
> - `video-agent-service/` (Cloud Run mới) — đã build + deploy (Gemini Developer API thay vì
>   Vertex AI như dự tính ban đầu do Gemini 3.x chưa mở trên Vertex cho project này — xem
>   `PLAN_vertex_ai_billing_draft.md`; endpoint health check là `/health`, không phải `/healthz`
>   như bảng API bên dưới, vì Cloud Run tự chặn ngầm path `/healthz`). Output thật có thêm 2
>   field ngoài dự tính ban đầu: `video_summary` (tóm tắt cảm xúc 2-3 câu) và
>   `video_styling_guideline` (gợi ý font/màu chữ cho phụ đề) — không phá vỡ thiết kế, chỉ là
>   bổ sung, Apps Script cũng đã lưu 2 field này (`video_summary` có cột riêng,
>   `video_styling_guideline` hiện chưa có cột lưu — thêm sau nếu cần dùng tới).
> - Phía Apps Script (`VideoAgentClient.gs` + các file sửa liệt kê ở mục "File Apps Script") —
>   đã code xong đúng theo quyết định 1-5 ở trên, bao gồm cả việc gửi `video_style_rules` (đọc
>   từ sheet Rules, scope `video_style` — cơ chế externalize prompt bàn sau khi viết plan này,
>   xem `Rules.gs`) trong `context` khi submit job.
> - **Quyết định 5 đã bị SỬA LẠI** (xem đánh dấu ~~gạch ngang~~ bên dưới): ban đầu chốt "không
>   gate", sau đó phát hiện sai — video là nguồn mô tả duy nhất đáng tin cậy khi hotel dùng
>   `video_folder_url` (input chỉ chắc chắn có tên KS + giá), nên đã đổi lại thành **CÓ gate**
>   chặn Agent 2 tới khi `video_description` sẵn sàng.
> - **Video Render Service cũng đã đổi input** (2026-08-26, xác nhận qua `/openapi.json` thật):
>   không còn nhận upload blob `video_file`/`music_file`, chuyển sang `video_folder_url` (link
>   thư mục Drive) + `clips` (JSON bọc `video_edit_script`) + `srt_text` + `music_url` (link) qua
>   `application/x-www-form-urlencoded`. Luồng thủ công cũ `video_drive_url`+`video_subtitle_srt`
>   không còn được hỗ trợ. Chi tiết ở mục "File Apps Script" và header comment `VideoRenderClient.gs`.

## Context

Pipeline hiện tại (`Orchestrator.gs` → Agent1-5) không có bước phân tích video: `video_drive_url` (1 file) + `video_subtitle_srt` (gõ tay) được submit thẳng sang Cloud Run "Video Render Service" đã có để ghép phụ đề/nhạc. Không có mô tả khách sạn nào được AI tự sinh ra từ video.

Mục tiêu: thêm 1 Cloud Run mới ("Video Agent", dùng Gemini) đọc toàn bộ video trong 1 thư mục Drive của khách sạn, tự viết mô tả + SRT mới + script cắt/ghép, rồi mới gọi sang Cloud Run render hiện có để tạo video thật. Phần dưới đây chốt lại các quyết định thiết kế sau khi trao đổi.

## Quyết định đã chốt

1. **Video là nguồn mô tả ưu tiên số 1.** Các cột thủ công tuỳ chọn (`destination`, `giai_doan`, `benefits_raw`, `booking_note`) chỉ bổ sung/kết hợp thêm khi người dùng có điền, không thay thế mô tả từ video.
2. **2 Cloud Run tách biệt**, không gộp chung:
   - **Cloud Run Video Agent (mới)** — Gemini, đọc N video trong 1 thư mục Drive, tổng hợp thành mô tả + SRT mới + script cắt/ghép.
   - **Cloud Run Video Render (đang chạy)** — giữ nguyên logic nội bộ, chỉ **đổi input nhận vào** (script cắt/ghép + SRT mới, thay vì 1 video + SRT gõ tay). Logic FFmpeg cắt/ghép thật sự bên trong service đó do dev khác phụ trách — **ngoài phạm vi** của tài liệu này, không cần viết hợp đồng API v2 chính thức cho họ, chỉ cần Apps Script gửi đúng field mới sang endpoint `/api/jobs` hiện có.
3. **Auth Cloud Run Video Agent → Google Drive: OAuth với refresh token cố định, không đổi** (không dùng service account, không dùng token ngắn hạn kiểu `ScriptApp.getOAuthToken()` vì hết hạn ~1h không phù hợp job phân tích lâu). Chi tiết ở mục "Auth" bên dưới.
4. **Apps Script chia 2 luồng xử lý cho bước "gen video"**, dựa trên cột mô tả video (`video_description`) đã có dữ liệu hay chưa:
   - **Luồng A — `video_description` đang trống:** gọi Cloud Run Video Agent để phân tích toàn bộ video → ghi kết quả vào `video_description` (+ `video_srt`, `video_edit_script`) → sau đó mới gọi Cloud Run Video Render hiện tại để gen video.
   - **Luồng B — `video_description` đã có sẵn** (từ lần chạy trước, hoặc người vận hành tự gõ tay): **bỏ qua Cloud Run Video Agent**, gọi thẳng Cloud Run Video Render hiện tại bằng dữ liệu đang có (`video_srt`, `video_edit_script` đã lưu từ trước) để gen video.
5. ~~Luồng Facebook/Zalo giữ nguyên như hiện tại, không gate~~ — **ĐÃ SỬA LẠI (xem cập nhật ở đầu tài liệu): CÓ gate.** Khi hotel có `video_folder_url`, `video_description` là nguồn mô tả **bắt buộc** phải có trước khi Agent 2 chạy — input sheet chỉ chắc chắn có tên KS + giá, các cột thủ công khác (`destination`, `giai_doan`, `benefits_raw`, `booking_note`) có thể hoàn toàn trống, nên Claude không có đủ dữ liệu để viết Facebook/Zalo có ý nghĩa nếu thiếu mô tả từ video. Vì vậy `processHotelRow_` có bước gate (`gateVideoAgentStep_`, đầu hàm, trước Agent 2): nếu vừa submit job Video Agent hoặc job đang `submitted`/`processing` → **return sớm, KHÔNG chạy Agent 2-5, KHÔNG set `status=done`** trong lượt đó. `checkVideoAgentJobs()` khi phát hiện job `succeeded` sẽ tự chạy tiếp toàn bộ phần còn lại (Agent2→3→4→Facebook→submit Render→Agent5) cho đúng dòng đó — không cần người vận hành bấm lại. Job lỗi (`error: ...`) hoặc hotel không dùng `video_folder_url` thì **không** gate — chạy Agent 2-5 ngay bằng cột thủ công đang có (graceful degradation, không chặn dòng vĩnh viễn).

## Cột Sheet

**Input:**

| Cột | Bắt buộc | Ghi chú |
|---|---|---|
| `hotel_id`, `ten_ks`, `gia` | ✅ | Theo Phần 1 discussion doc |
| `destination`, `giai_doan`, `benefits_raw`, `booking_note` | ❌ | Bổ sung, kết hợp cùng `video_description` |
| `video_folder_url` | ❌ | **Thay `video_drive_url`** — link thư mục Drive chứa nhiều video |
| `music_drive_url` | ❌ | Giữ nguyên |
| `drive_folder_url` | ❌ | Giữ nguyên — ảnh cho Facebook, không đổi |

**Output — Video Agent ghi vào:**

| Cột | Mô tả | Vai trò |
|---|---|---|
| `video_description` | Mô tả tổng hợp từ toàn bộ video (tiện ích, không gian, điểm bán hàng...) | Vừa là nội dung feed cho Agent2-4, vừa là **cờ kiểm tra** để quyết định Luồng A/B |
| `video_srt` | 1 khối SRT mới (~30-60s), biên tập lại từ nội dung các video | Input cho Cloud Run render |
| `video_edit_script` | JSON danh sách clip cần cắt để khớp `video_srt`, vd `[{"source_video":"tour_lobby.mp4","start":"00:15","end":"00:20"}]` | Input cho Cloud Run render |
| `video_agent_status` | `skipped: no_video` / `submitted` / `processing` / `succeeded` / `error: ...` | Theo dõi job bất đồng bộ (chỉ dùng nội bộ cho Luồng A) |
| `video_agent_job_id` | id job để poll | |
| `video_agent_at` | thời điểm cập nhật gần nhất | |

**Output hiện có, giữ nguyên tên cột:** `video_render_status`, `video_render_job_id`, `video_render_url`, `video_render_at` — chỉ đổi nguồn dữ liệu submit (mục "Luồng xử lý").

## Cloud Run Video Agent — API & Auth

**Ngôn ngữ đề xuất:** Python (Gemini SDK + xử lý video).

**API (mirror pattern job bất đồng bộ đã có ở Video Render Service để tái dùng hạ tầng poll/trigger phía Apps Script):**

| Endpoint | Method | Mô tả |
|---|---|---|
| `/api/jobs` | POST | `{hotel_id, folder_id, context: {ten_ks, destination, gia, giai_doan, benefits_raw, booking_note, video_style_rules}, target_duration_seconds: [30,60]}` → `{job_id}` |
| `/api/jobs/{job_id}` | GET | `{status: queued\|analyzing\|synthesizing\|succeeded\|failed, output: {video_description, video_summary, video_srt, video_edit_script, video_styling_guideline}, error}` |
| `/health` | GET | health check (đổi từ `/healthz` — Cloud Run tự chặn ngầm path đó) |

**Xử lý nội bộ (2 bước Gemini):**
1. Liệt kê file video trong `folder_id` (đọc Drive trực tiếp — xem Auth bên dưới), lọc mime `video/*`. Upload từng video lên Gemini File API, phân tích cảnh/tiện ích/transcript có timestamp/điểm bán hàng.
2. **Tổng hợp** (1 Gemini call dùng kết quả bước 1 + `context` khách sạn): viết `video_description` (mô tả tổng hợp cho content Facebook/Zalo), đồng thời biên tập 1 kịch bản ngắn 30-60s → sinh `video_srt` (timeline mới) + `video_edit_script` (khớp timeline với `video_srt`).

Model đề xuất: **Gemini Flash** cho cả 2 bước. Giới hạn mặc định (điều chỉnh được): tối đa ~10 video/khách sạn, mỗi video ≤ 5 phút.

**Auth — Apps Script → Cloud Run Video Agent:**
Bearer token, giống hệt pattern `VIDEO_RENDER_API_TOKEN` hiện tại → thêm `getVideoAgentApiToken_()`/`isVideoAgentConfigured_()` (`Config.gs`), `promptForVideoAgentToken()` (`Setup.gs`).

**Auth — Cloud Run Video Agent → Google Drive: OAuth refresh token cố định, không đổi.**
- Tạo 1 OAuth Client (Desktop hoặc Web) trong GCP project.
- Chạy **1 lần duy nhất** flow cấp quyền OAuth (`access_type=offline`, `prompt=consent`, scope `drive.readonly`) bằng tài khoản Google đang sở hữu/có quyền truy cập các thư mục video khách sạn → nhận về `refresh_token`.
- Lưu cố định `client_id`, `client_secret`, `refresh_token` làm secret của Cloud Run (Secret Manager hoặc biến môi trường) — **không đổi theo thời gian**, không cần re-auth (refresh token của Google chỉ mất hiệu lực nếu bị thu hồi thủ công hoặc không dùng liên tục >6 tháng).
- Mỗi lần cần gọi Drive API, Cloud Run tự dùng `refresh_token` này đổi lấy access token ngắn hạn — hoàn toàn tự động, không cần Apps Script hay người vận hành can thiệp lại.
- Apps Script **không gửi bất kỳ token Drive nào** — chỉ gửi `folder_id` (trích từ `video_folder_url`, tái dùng `extractDriveFolderId_()` đã có sẵn trong `DriveImagePicker.gs`).
- **1 lần xác thực dùng chung cho mọi khách sạn** — không phải mỗi folder/khách sạn lại xác thực lại. Điều kiện duy nhất: tài khoản đứng sau `refresh_token` phải có quyền đọc folder đó (giống hệt yêu cầu hiện tại của `DriveApp` trong Apps Script). Khuyến nghị lấy `refresh_token` bằng **đúng tài khoản đang vận hành Apps Script hôm nay** để kế thừa toàn bộ quyền share sẵn có, không phát sinh việc share lại. Nếu có Google Workspace, nên gom folder video các khách sạn vào 1 Shared Drive để không phải share thủ công khi thêm khách sạn mới (`drive_client.py` đã bật `supportsAllDrives`).

## Stack kỹ thuật (đã chốt)

**Ngôn ngữ & framework:** Python 3.12 + FastAPI — async tốt cho việc gọi Gemini/Drive API (I/O-bound), tự sinh `/openapi.json` giống cách Cloud Run render hiện tại đang có, hệ sinh thái Google client library cho Python mạnh nhất.

**Gemini:** SDK `google-genai` (SDK Gemini hợp nhất chính thức), dùng Files API để upload từng video rồi phân tích. Model chọn qua biến môi trường `GEMINI_MODEL` (mặc định `gemini-2.5-flash`), không hardcode cứng để dễ đổi Flash/Pro sau này.

**Xử lý job bất đồng bộ trên Cloud Run:** Cloud Run không giữ tiến trình chạy nền sau khi trả response trừ khi bật "CPU always allocated" (tốn thêm chi phí, phải chạy tối thiểu 1 instance liên tục). Dùng pattern chuẩn, rẻ hơn:
- `POST /api/jobs` → tạo bản ghi job trong **Firestore** (`status=queued`), đẩy 1 task vào **Cloud Tasks**, trả `job_id` ngay lập tức.
- Cloud Tasks gọi lại endpoint nội bộ `POST /internal/process-job/{job_id}` — request này được phép chạy lâu (Cloud Run cho timeout tới 60 phút), thực hiện toàn bộ việc phân tích + tổng hợp, rồi ghi kết quả vào Firestore.
- `GET /api/jobs/{job_id}` chỉ đọc từ Firestore.
- Khi chạy local/dev (không cấu hình `CLOUD_TASKS_QUEUE`), service tự chuyển sang chạy bằng FastAPI `BackgroundTasks` trong cùng tiến trình thay vì gọi Cloud Tasks — không cần hạ tầng GCP thật để test luồng end-to-end tại máy.

**Auth Drive (theo refresh token cố định đã chốt):** `google.oauth2.credentials.Credentials(refresh_token=..., client_id=..., client_secret=..., token_uri="https://oauth2.googleapis.com/token")` + `googleapiclient.discovery.build('drive', 'v3', credentials=...)`. Refresh token lấy 1 lần bằng script riêng (xem `scripts/get_refresh_token.py`), không phải service account.

**Secrets:** `client_secret`, `refresh_token`, Bearer token xác thực Apps Script → service — lưu trong **Secret Manager**, mount làm biến môi trường lúc deploy, không hardcode/commit.

**Container & deploy:** `Dockerfile` (python:3.12-slim), deploy bằng `gcloud run deploy` hoặc Cloud Build trigger.

**Test:** `pytest`, mock lời gọi Gemini/Drive để test riêng logic tổng hợp `video_description`/`video_srt`/`video_edit_script` mà không tốn API call thật.

**Vị trí code:** thư mục con `video-agent-service/` trong project tổng này (`c:\Working\appjs`), tách biệt hoàn toàn khỏi code Apps Script (`.gs`) ở thư mục gốc.

---

## Luồng xử lý (gate đầu `processHotelRow_`, thay vì chỉ đổi bước "Video" ở cuối)

`processHotelRow_` có thêm bước 0 **trước Agent 2**, gọi `gateVideoAgentStep_(sheet, rowNumber, columnMap, hotel)` (never-throw):

```
Không có video_folder_url
  → video_agent_status = 'skipped: no_video', KHÔNG gate — chạy tiếp Agent 2-5 ngay bằng cột
    thủ công / video_drive_url cũ (giữ hành vi hiện tại)

Có video_folder_url:
  video_agent_status đang 'submitted'/'processing'
    → shouldReturnEarly=true: KHÔNG chạy Agent 2-5 trong lượt này, KHÔNG set status='done'
      (tránh submit trùng job khi runMarketingAutomation quét lại dòng chưa 'done')

  video_agent_status === 'succeeded'
    → KHÔNG gate — video_description/video_srt/video_edit_script đã có sẵn trong sheet, chạy
      tiếp Agent 2-5 ngay

  video_agent_status bắt đầu 'error:' hoặc 'skipped:'
    → KHÔNG gate — graceful degradation, chạy tiếp Agent 2-5 bằng cột thủ công đang có (không
      chặn dòng vĩnh viễn chỉ vì 1 job lỗi)

  video_agent_status rỗng (lần đầu thấy video_folder_url)
    → submit job sang Cloud Run Video Agent, set video_agent_status='submitted', đảm bảo trigger
      checkVideoAgentJobs tồn tại (ensureVideoAgentPollTrigger_) → shouldReturnEarly=true
    → nếu submit lỗi (mạng/token...) → set video_agent_status='error: ...', KHÔNG gate (fallback
      ngay trong lượt này thay vì chặn vĩnh viễn)
```

Khi `shouldReturnEarly=false`, `processHotelRow_` chạy tiếp `runRestOfPipelineForRow_` (Agent2→3→4→Facebook draft→submit Render bằng `maybeSubmitVideoRenderJob_`→Agent5 lưu kết quả) — y hệt logic `processHotelRow_` cũ, chỉ tách thành hàm riêng để tái dùng.

**`checkVideoAgentJobs()` (trigger mới, mirror `checkVideoRenderJobs`)** — khi 1 job Video Agent `succeeded`:
1. Ghi `video_description`, `video_summary`, `video_srt`, `video_edit_script` vào sheet, set `video_agent_status='succeeded'`.
2. **Gọi luôn `runRestOfPipelineForRow_`** cho đúng dòng đó — vì Agent 2-4 đã bị gate chặn ở lượt submit ban đầu, phải chạy lại từ đây thì dòng mới hoàn tất (Agent2→3→4→Facebook→submit Render→Agent5), không cần người vận hành tự bấm lại "Chạy toàn bộ". Có `LockService` tránh đụng độ với `runMarketingAutomation` chạy song song, và guard theo `MAX_RUNTIME_MS` nếu nhiều dòng `succeeded` cùng lúc (dòng chưa kịp xử lý vẫn ở `video_agent_status='succeeded'`, sẽ được lượt sau nhặt lại vì không còn bị gate).
3. Job `failed` → chỉ ghi `video_agent_status='error: ...'`, không tự chạy tiếp — lượt "Chạy toàn bộ danh sách"/"Chạy dòng đang chọn" kế tiếp sẽ tự fallback qua cột thủ công (nhánh `error:` không gate).
4. Khi không còn job Video Agent nào `submitted` → tự xoá trigger của chính nó (giống `checkVideoRenderJobs` hiện tại).

`checkVideoRenderJobs()` (poll job Render hiện tại) **giữ nguyên hoàn toàn**.

## File Apps Script — thay đổi cụ thể

**File mới:** `VideoAgentClient.gs` — mirror `VideoRenderClient.gs`: `submitVideoAgentJob_()`, `getVideoAgentJobStatus_()`, `ensureVideoAgentPollTrigger_()`, `gateVideoAgentStep_()` (never-throw gate, gọi đầu `processHotelRow_` — KHÔNG phải cuối như bước "Video" của `maybeSubmitVideoRenderJob_` cũ), `checkVideoAgentJobs()`. `Orchestrator.gs` có thêm `runRestOfPipelineForRow_()` (tách từ `processHotelRow_` cũ) để cả `processHotelRow_` và `checkVideoAgentJobs()` cùng gọi lại được.

**File sửa:**
- `Config.gs` — thêm `getVideoAgentApiToken_()`/`isVideoAgentConfigured_()`.
- `Setup.gs` — thêm `promptForVideoAgentToken()` + menu item.
- `Orchestrator.gs` — thêm menu "Kiểm tra tiến độ phân tích video"; cộng cột mới vào `requiredColumns`; thêm gọi `gateVideoAgentStep_` đầu `processHotelRow_`, tách phần còn lại (Agent2-5) thành `runRestOfPipelineForRow_` để `checkVideoAgentJobs()` gọi lại được.
- `Agent2_BuyerPersona.gs`, `Agent3_CampaignBrief.gs`, `Agent4_PlatformContent.gs` — đổi cách build user prompt: đưa `video_description` (nếu có) lên thành khối "PHÂN TÍCH TỪ VIDEO (ưu tiên chính)", cột thủ công tuỳ chọn thành khối "Thông tin bổ sung" nối sau. Không đổi thời điểm/thứ tự các agent này chạy.
- `Agent5_SaveResults.gs` — thêm ghi các cột `video_description`/`video_srt`/`video_edit_script`/`video_agent_status`/`video_agent_job_id`/`video_agent_at`.
- `VideoRenderClient.gs` — **ĐÃ XÁC NHẬN contract thật** (`/openapi.json` của Video Render Service, 2026-08-26, không còn là đề xuất tạm): `POST /api/jobs` giờ là `application/x-www-form-urlencoded` với `video_folder_url` (link thư mục Drive, service tự đọc video nguồn — không nhận upload blob `video_file`/`music_file` nữa), `clips` (JSON string, PHẢI bọc `video_edit_script` trong object: `{"video_edit_script": [...]}`, không gửi thẳng mảng), `srt_text` = `video_srt`, `intro_text` (chưa có nguồn dữ liệu, để trống), `music_url` = `music_drive_url` (link, không phải blob), `options`. Luồng thủ công cũ (`video_drive_url`+`video_subtitle_srt`, không có `video_folder_url`) không còn được service hỗ trợ — trả `error: ...` rõ ràng thay vì âm thầm gọi sai field.
- `Utils.gs` — tái dùng `extractDriveFolderId_()` có sẵn trong `DriveImagePicker.gs`, không viết lại.
- `ARCHITECTURE.md` — cập nhật sau khi code xong.

## Ngoài phạm vi

- Logic FFmpeg cắt/ghép thật sự theo `video_edit_script` bên trong Cloud Run Render — do dev khác phụ trách.
- Tài liệu hợp đồng API v2 chính thức cho Cloud Run Render.
- Đăng video render lên Facebook tự động (giữ nguyên: chỉ lưu link).
- API đăng bài Zalo (vẫn chỉ sinh `zalo_copy`, đăng tay).
- Setup OAuth Client + lấy `refresh_token` ban đầu (thao tác 1 lần, phía GCP/ops) — nêu trong tài liệu vận hành, không phải code Apps Script.

## Kiểm thử khi code xong

1. Dòng test có `video_folder_url`, `video_description` rỗng → chạy "Chạy dòng đang chọn" → `video_agent_status=submitted`; alert báo "đang chờ Video Agent"; **`facebook_copy`/`zalo_copy`/`status` KHÔNG được sinh/set trong lượt này** (gate chặn Agent 2-5).
2. Đợi/bấm "Kiểm tra tiến độ phân tích video" → `video_agent_status=succeeded`, `video_description`/`video_summary`/`video_srt`/`video_edit_script` có dữ liệu hợp lệ, **và** pipeline tự chạy tiếp (`facebook_copy`/`zalo_copy` được sinh phản ánh đúng `video_description` vừa có, `video_render_status` tự chuyển `submitted`, `status=done`) mà không cần thao tác thêm.
3. Dòng có `video_folder_url` nhưng `video_description` đã được gõ tay sẵn từ đầu → chạy lần đầu tiên KHÔNG gate (video_agent_status rỗng nhưng video_description đã có → coi như Luồng B), Agent 2-5 chạy ngay, gọi Render ngay, không submit job Video Agent.
4. Dòng không có `video_folder_url` → `video_agent_status='skipped: no_video'`, KHÔNG gate, hành vi y hệt hiện tại (chỉ dựa cột thủ công).
5. Test job Video Agent lỗi (`error: ...`) → KHÔNG gate ở lượt chạy kế tiếp, Agent 2-5 vẫn chạy bằng cột thủ công đang có (dòng vẫn `done`, `facebook_copy`/`zalo_copy` không phản ánh video).
6. Test không bị submit trùng job khi bấm "Chạy toàn bộ danh sách" nhiều lần liên tiếp trong lúc `video_agent_status='submitted'`/`'processing'` — mỗi lần đều return sớm, không tạo job mới.
