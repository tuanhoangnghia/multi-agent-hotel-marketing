# Video: ghép phụ đề + nhạc nền qua Video Render Service

> [!WARNING]
> **Tài liệu lịch sử — contract API `POST /api/jobs` mô tả dưới đây (multipart, `video_file`/`music_file` dạng blob) đã LỖI THỜI.** Bên vận hành Video Render Service đã đổi hẳn sang `application/x-www-form-urlencoded` với `video_folder_url` (link thư mục Drive) + `clips` (JSON, bọc `{"video_edit_script": [...]}`) + `srt_text` + `intro_text` + `music_url` (link, không phải blob) + `options` — xác nhận qua `/openapi.json` thật ngày 2026-08-26. `DriveFileHelper.gs` (file mô tả bên dưới) đã bị xoá vì không còn dùng đến (không còn fetch blob). Xem contract mới trong header comment của `VideoRenderClient.gs` và mục "Luồng xử lý" trong `PLAN_video_agent_draft.md`. Phần còn lại của tài liệu này (kiến trúc job bất đồng bộ, poll trigger, cột sheet `video_render_status`/`video_render_job_id`/`video_render_url`/`video_render_at`) vẫn đúng, chỉ riêng phần "input gửi lên khi tạo job" là đã thay đổi.

## Context

Bên cạnh nhánh Facebook (ảnh + draft post), dự án cần thêm 1 flow độc lập: ghép phụ đề (subtitle) và nhạc nền vào video khách sạn, dùng 1 service render video ngoài (Cloud Run):
`https://video-render-service-938843422997.asia-southeast1.run.app`

Đã phân tích OpenAPI spec (`/openapi.json`) của service này:

| Endpoint | Method | Auth | Chức năng |
|---|---|---|---|
| `/api/jobs` | POST | Bearer | Tạo job render — multipart: `video_file`/`video_url`, `srt_file`/`srt_url`/`srt_text`, `music_file`/`music_url`, `options` (JSON string, **schema không được document**, ví dụ `"{}"`) |
| `/api/jobs/{job_id}` | GET | Bearer | Poll trạng thái: `status` (queued→downloading→probing→rendering→uploading→succeeded/failed/cancelled), `progress`, `output.download_url`, `output.drive_view_url` (nullable), `error.message` |
| `/api/jobs/{job_id}` | DELETE | Bearer | Huỷ job (chưa dùng trong bản này) |
| `/api/jobs/{job_id}/download` | GET | Bearer | Tải file kết quả (chưa dùng — chỉ lưu link) |
| `/healthz` | GET | Không | Health check |

Render là tác vụ **bất đồng bộ**, có thể mất vài phút — vượt quá 6 phút/lần chạy của Apps Script. Vì vậy submit job và theo dõi kết quả phải tách làm 2 bước, dùng time-trigger lặp lại để poll — đúng pattern "tự resume qua trigger" đã có sẵn ở `runMarketingAutomation`.

Các quyết định đã chốt với người dùng:
- Video nguồn: **cột Drive link riêng từng dòng** (`video_drive_url`), không dùng video mẫu chung.
- Phụ đề: **người dùng tự dán text SRT thẳng vào 1 ô sheet** (`video_subtitle_srt`), không tự sinh bằng Claude, không cần file riêng trên Drive.
- Nhạc nền: **cột Drive link riêng từng dòng** (`music_drive_url`), không phải 1 track cố định dùng chung.
- Sau khi render xong: **chỉ lưu link kết quả vào sheet** (`video_render_url`), không tự động đăng đi đâu cả.

## Các file thay đổi / thêm mới

**File mới:**
- `DriveFileHelper.gs` — trích ID + lấy Blob của **1 file** Drive từ link chia sẻ (khác `DriveImagePicker.gs` vốn đọc cả 1 thư mục nhiều ảnh).
- `VideoRenderClient.gs` — gọi Video Render Service: submit job, poll trạng thái, quản lý trigger poll định kỳ, hàm điều phối never-throw khi submit.

**File sửa (thêm nhỏ):**
- `Config.gs` — `getVideoRenderApiToken_()`, `isVideoRenderConfigured_()`.
- `Setup.gs` — `promptForVideoRenderToken()`.
- `Orchestrator.gs` — 2 menu item mới; `processHotelRow_` gọi `maybeSubmitVideoRenderJob_` sau bước Facebook; 2 nơi build `requiredColumns` thêm cột mới.
- `Agent5_SaveResults.gs` — thêm cột output/input video, ghi `video_render_status`/`video_render_job_id` khi submit.

Bước video **độc lập với danh sách platforms** — chạy bất cứ khi nào `video_drive_url` có giá trị, không phụ thuộc việc có bật platform `facebook` hay không.

## Cột trong sheet

**Input mới:**
- `video_drive_url` — link Drive tới video gốc.
- `video_subtitle_srt` — nội dung SRT dán thẳng vào ô (nhiều dòng, có timestamp).
- `music_drive_url` — link Drive tới file nhạc nền.

**Output mới:**
- `video_render_status` — `skipped: no_video` / `skipped: no_video_render_config` / `submitted` / `processing` / `done` / `error: ...`
- `video_render_job_id` — id job trả về khi submit, dùng để poll.
- `video_render_url` — `drive_view_url` (nếu service tự đẩy lên Drive) hoặc `download_url`, chỉ có khi `status = done`.
- `video_render_at` — thời điểm cập nhật trạng thái gần nhất.

Độc lập hoàn toàn với cột `status`/`last_run_at` chung của dòng — cùng lý do như nhánh Facebook: lỗi render video không được làm dòng bị coi là "chưa xong" và bị xử lý lại từ đầu (tốn Claude API call oan).

## Luồng xử lý s

1. **Submit** (trong `processHotelRow_`, sau bước Facebook): nếu có `video_drive_url` và đã cấu hình token → lấy Blob video (+ nhạc nếu có) từ Drive, gọi `POST /api/jobs`, lưu `job_id`, đặt `video_render_status = submitted`. Nếu vừa submit thành công → đảm bảo có time-trigger `checkVideoRenderJobs` chạy mỗi 2 phút (`ensureVideoRenderPollTrigger_`, không tạo trùng nếu đã có).
2. **Poll** (`checkVideoRenderJobs`, chạy qua trigger hoặc bấm tay menu "Kiểm tra tiến độ render video"): quét toàn bộ sheet, với mỗi dòng có `video_render_status` là `submitted`/`processing` → gọi `GET /api/jobs/{job_id}`:
   - `succeeded` → ghi `done` + `video_render_url`.
   - `failed`/`cancelled` → ghi `error: <message>`.
   - còn lại (`queued`/`downloading`/`probing`/`rendering`/`uploading`) → ghi `processing`, vẫn còn job chờ.
   - lỗi gọi API (mạng, timeout) → giữ nguyên, thử lại lần poll sau, không vội báo lỗi.
3. Khi không còn dòng nào `submitted`/`processing` → `checkVideoRenderJobs` tự xoá trigger của chính nó (giống cách `runMarketingAutomation` dọn trigger cũ bằng `deleteExistingTriggers_`).

## Chi tiết implementation

### `DriveFileHelper.gs` (mới)

```js
function extractDriveFileId_(url) {
  if (!url) return null;
  var trimmed = String(url).trim();
  var match = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

function fetchDriveFileBlob_(driveFileUrl) {
  var fileId = extractDriveFileId_(driveFileUrl);
  if (!fileId) {
    throw new Error('URL file Drive không hợp lệ: ' + driveFileUrl);
  }
  try {
    return DriveApp.getFileById(fileId).getBlob();
  } catch (error) {
    throw new Error('Không truy cập được file Drive (chưa share hoặc ID sai): ' + fileId);
  }
}
```

### `VideoRenderClient.gs` (mới)

```js
var VIDEO_RENDER_BASE_URL_ = 'https://video-render-service-938843422997.asia-southeast1.run.app';
var VIDEO_RENDER_POLL_TRIGGER_HANDLER_ = 'checkVideoRenderJobs';
var VIDEO_RENDER_POLL_INTERVAL_MINUTES_ = 2;

function videoRenderAuthHeader_() {
  return { Authorization: 'Bearer ' + getVideoRenderApiToken_() };
}

function videoRenderErrorMessage_(body) {
  try {
    var json = JSON.parse(body);
    return json.detail || json.message || body;
  } catch (e) {
    return body;
  }
}

function submitVideoRenderJob_(videoBlob, srtText, musicBlob) {
  var payload = { video_file: videoBlob, options: '{}' };
  if (srtText) payload.srt_text = srtText;
  if (musicBlob) payload.music_file = musicBlob;

  var response = UrlFetchApp.fetch(VIDEO_RENDER_BASE_URL_ + '/api/jobs', {
    method: 'post',
    headers: videoRenderAuthHeader_(),
    payload: payload,
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200 && code !== 202) {
    throw new Error('Video Render API lỗi khi tạo job (HTTP ' + code + '): ' + videoRenderErrorMessage_(body));
  }
  return JSON.parse(body).job_id;
}

function getVideoRenderJobStatus_(jobId) {
  var response = UrlFetchApp.fetch(VIDEO_RENDER_BASE_URL_ + '/api/jobs/' + jobId, {
    headers: videoRenderAuthHeader_(),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    throw new Error('Video Render API lỗi khi kiểm tra job (HTTP ' + code + '): ' + videoRenderErrorMessage_(body));
  }
  return JSON.parse(body);
}

function ensureVideoRenderPollTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === VIDEO_RENDER_POLL_TRIGGER_HANDLER_;
  });
  if (!exists) {
    ScriptApp.newTrigger(VIDEO_RENDER_POLL_TRIGGER_HANDLER_)
      .timeBased()
      .everyMinutes(VIDEO_RENDER_POLL_INTERVAL_MINUTES_)
      .create();
  }
}

function maybeSubmitVideoRenderJob_(hotel) {
  var videoUrl = hotel && hotel['video_drive_url'];
  if (!videoUrl || String(videoUrl).trim() === '') {
    return { status: 'skipped: no_video' };
  }
  if (!isVideoRenderConfigured_()) {
    return { status: 'skipped: no_video_render_config' };
  }
  try {
    var videoBlob = fetchDriveFileBlob_(videoUrl);
    var musicUrl = hotel['music_drive_url'];
    var musicBlob = musicUrl ? fetchDriveFileBlob_(musicUrl) : null;
    var srtText = hotel['video_subtitle_srt'] ? String(hotel['video_subtitle_srt']) : '';
    var jobId = submitVideoRenderJob_(videoBlob, srtText, musicBlob);
    return { status: 'submitted', jobId: jobId };
  } catch (error) {
    console.error('Lỗi submit video render job: ' + error.message);
    return { status: 'error: ' + error.message };
  }
}

function checkVideoRenderJobs() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getSheetName_());
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var columnMap = {};
  headers.forEach(function (name, index) { columnMap[name] = index + 1; });
  if (!columnMap['video_render_status'] || !columnMap['video_render_job_id']) return;

  var stillPending = false;

  for (var i = 1; i < values.length; i++) {
    var status = String(values[i][columnMap['video_render_status'] - 1] || '');
    var jobId = String(values[i][columnMap['video_render_job_id'] - 1] || '');
    if (!jobId || (status !== 'submitted' && status !== 'processing')) continue;

    var rowNumber = i + 1;
    try {
      var job = getVideoRenderJobStatus_(jobId);
      if (job.status === 'succeeded') {
        var url = (job.output && (job.output.drive_view_url || job.output.download_url)) || '';
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('done');
        sheet.getRange(rowNumber, columnMap['video_render_url']).setValue(url);
        sheet.getRange(rowNumber, columnMap['video_render_at']).setValue(new Date());
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        var message = (job.error && job.error.message) || job.status;
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('error: ' + message);
        sheet.getRange(rowNumber, columnMap['video_render_at']).setValue(new Date());
      } else {
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('processing');
        stillPending = true;
      }
    } catch (error) {
      console.error('Lỗi kiểm tra video render job ' + jobId + ': ' + error.message);
      stillPending = true;
    }
  }

  if (!stillPending) {
    deleteExistingTriggers_(VIDEO_RENDER_POLL_TRIGGER_HANDLER_);
  }
}
```

### `Config.gs` / `Setup.gs` / `Orchestrator.gs` / `Agent5_SaveResults.gs`

Xem trực tiếp trong code — pattern giống hệt nhánh Facebook (getter throw-if-missing, `ui.prompt` lưu Script Properties, cột output độc lập với `status`).

## Thiết lập Bearer Token

Service này không phải do hướng dẫn này tạo ra — token xác thực (Bearer) phải xin từ **người đang vận hành Cloud Run service** đó (kiểm tra biến môi trường/config phía server, ví dụ `API_TOKEN`/`AUTH_TOKEN`). Sau khi có token:

1. Vào Google Sheet → menu **🤖 AI Marketing → Thiết lập Video Render API** → dán Bearer Token.
2. Điền `video_drive_url`, `video_subtitle_srt`, `music_drive_url` (nhạc nền không bắt buộc) cho dòng khách sạn cần render.
3. Chạy **Chạy dòng đang chọn** hoặc **Chạy toàn bộ danh sách** như bình thường.
4. Theo dõi `video_render_status` — tự chuyển `submitted` → `processing` → `done`/`error` sau vài lần trigger chạy (mỗi 2 phút/lần). Có thể bấm **Kiểm tra tiến độ render video** để poll ngay không cần chờ trigger.

## Giới hạn được chấp nhận có chủ đích

- **Schema của `options` không được document công khai** trong OpenAPI spec (chỉ ghi ví dụ `"{}"`) — hiện gửi rỗng, không cấu hình được độ phân giải/style phụ đề/tỉ lệ khung hình qua code. Muốn dùng cần hỏi trực tiếp người viết service này.
- **Giới hạn dung lượng**: Apps Script `UrlFetchApp` có giới hạn khoảng 50MB cho payload — video/nhạc quá lớn sẽ submit lỗi (`error: ...`). Không có cảnh báo trước khi thử.
- **Không tự retry** khi submit thất bại (tránh submit trùng job nếu lỗi chỉ là do mạng chập chờn) — submit lỗi thì phải tự chạy lại dòng đó.
- **Không xoá job cũ** (`DELETE /api/jobs/{job_id}`) — chưa cần thiết ở quy mô hiện tại, có thể bổ sung sau nếu cần dọn dẹp.
- **`video_render_url` có thể trống dù `status = done`** nếu cả `drive_view_url` và `download_url` đều rỗng phía API — chưa gặp nhưng để phòng hờ.
- Không tự động đăng video lên Facebook — chỉ lưu link, đăng thủ công nếu cần (khác nhánh ảnh).

## Kiểm thử

1. Dán 2 file mới (`DriveFileHelper.gs`, `VideoRenderClient.gs`) và các phần sửa vào Apps Script editor.
2. Chạy **Thiết lập Video Render API**, dán Bearer Token.
3. Điền `video_drive_url` (+ `video_subtitle_srt`, `music_drive_url`) cho 1 dòng test, chạy **Chạy dòng đang chọn**.
4. Kiểm tra ngay sau khi chạy: `video_render_status = submitted`, `video_render_job_id` có giá trị.
5. Đợi 1-2 phút, bấm **Kiểm tra tiến độ render video** (hoặc chờ trigger tự chạy) — `video_render_status` chuyển `processing` rồi `done`, `video_render_url` có giá trị.
6. Mở link đó xác nhận video đã ghép đúng phụ đề + nhạc.
7. Test trường hợp lỗi: dòng không có `video_drive_url` → `skipped: no_video`; token sai → `error: ...` ngay từ bước submit; các cột persona/brief/platform/Facebook khác vẫn được lưu đầy đủ, `status` dòng vẫn `done`.
