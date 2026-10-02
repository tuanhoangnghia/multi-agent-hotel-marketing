# Video Agent Service

Cloud Run service mới (Python + FastAPI) — đọc toàn bộ video trong 1 thư mục Drive của khách sạn,
dùng Gemini phân tích rồi tổng hợp thành `video_description`, `video_srt` (~30-60s), và
`video_edit_script` (cut list) để Cloud Run "Video Render" hiện có dùng gen video mới.

Kiến trúc/quyết định chi tiết: xem [`../PLAN_video_agent_draft.md`](../PLAN_video_agent_draft.md).

## Cài đặt & chạy local

```bash
cd video-agent-service
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements-dev.txt
copy .env.example .env        # rồi điền giá trị thật vào .env
uvicorn app.main:app --reload --port 8080
```

Khi `.env` chưa có `CLOUD_TASKS_QUEUE`, job sẽ chạy ngay bằng `BackgroundTasks` trong
cùng tiến trình — không cần Cloud Tasks/Firestore thật để test nhanh (Firestore vẫn cần
1 project GCP thật vì đây là nơi lưu trạng thái job; có thể dùng Firestore emulator khi dev).

## Lấy Drive OAuth refresh token (làm 1 lần)

```bash
cd scripts
pip install -r ../requirements-dev.txt
python get_refresh_token.py
```

Xem hướng dẫn chi tiết trong docstring của [`scripts/get_refresh_token.py`](scripts/get_refresh_token.py).

> [!IMPORTANT]
> **Đây là bước xác thực DUY NHẤT, dùng chung cho mọi khách sạn mãi mãi** — không phải mỗi
> folder/khách sạn lại phải authenticate lại. Apps Script chỉ gửi `folder_id`, Cloud Run dùng
> chung 1 `refresh_token` này để đọc bất kỳ folder nào mà tài khoản đứng sau nó có quyền xem.
>
> Vấn đề thật sự cần quan tâm là **quyền chia sẻ (share) folder**, không phải xác thực:
> - **Đăng nhập bằng đúng tài khoản Google đang sở hữu/vận hành Apps Script hiện tại** khi chạy
>   `get_refresh_token.py` — tài khoản này đã có sẵn quyền đọc mọi folder khách sạn (vì
>   `DriveApp` trong `.gs` hiện tại đang dùng chính tài khoản đó), nên Cloud Run tự động kế
>   thừa toàn bộ quyền, **không cần share lại folder nào**.
> - Nếu có Google Workspace: nên gom toàn bộ folder video khách sạn vào **1 Shared Drive**
>   duy nhất, thêm tài khoản trên làm thành viên 1 lần — từ đó thêm bao nhiêu khách sạn mới
>   cũng chỉ cần tạo folder con trong Shared Drive đó, không cần share thủ công nữa
>   (`app/drive_client.py` đã bật `supportsAllDrives`/`includeItemsFromAllDrives` để đọc được
>   nội dung trong Shared Drive).
> - Nếu folder khách sạn nằm rải rác ở nhiều tài khoản cá nhân khác nhau (không dùng chung 1
>   tài khoản/Shared Drive): mỗi folder mới vẫn cần 1 bước "Share" thủ công 1 lần cho tài khoản
>   trên — đây là thao tác chia sẻ Drive bình thường, không phải chạy lại OAuth flow.

## Chạy test

```bash
pytest
```

## Test local bằng Docker Desktop

Có thể test toàn bộ service (build image + chạy như trên Cloud Run) ngay trên máy bằng Docker Desktop.
Gemini gọi qua **Vertex AI** (không dùng API key) — cần các phần **không thể giả lập** sau, bắt
buộc phải là thật dù test local hay production:

- 1 **GCS bucket** thật (đã tạo, quyền `storage.objectAdmin` cho service account/credential đang test) —
  dùng để stage video trước khi gọi Gemini, vì `client.files.upload()` (Files API) không hoạt động
  ở chế độ Vertex AI, phải qua GCS + `Part.from_uri()` thay thế (xem `app/gcs_client.py`).
- **`DRIVE_CLIENT_ID`/`DRIVE_CLIENT_SECRET`/`DRIVE_REFRESH_TOKEN`** thật — chạy `scripts/get_refresh_token.py`
  1 lần với 1 tài khoản Google có quyền truy cập 1 thư mục Drive test (vài video ngắn ~10-30s để đỡ tốn thời gian/quota Gemini khi test).
- Một nơi lưu trạng thái job — chọn 1 trong 2 cách bên dưới.
- Credential test cần có cả `roles/aiplatform.user` (gọi Vertex AI) lẫn `roles/storage.objectAdmin`
  trên bucket ở trên.

`CLOUD_TASKS_QUEUE` cứ **để trống** khi test local — service tự chạy job bằng `BackgroundTasks`
trong cùng tiến trình, không cần Cloud Tasks thật.

### Cách A — dùng Firestore thật (khuyến nghị, ít rủi ro sai khác với production)

1. Tạo 1 GCP project (free tier), bật Firestore API + Vertex AI API (`aiplatform.googleapis.com`),
   tạo database Firestore ở chế độ **Native mode**, tạo 1 GCS bucket (`gcloud storage buckets create`).
2. IAM & Admin → Service Accounts → tạo 1 service account, gán role **Cloud Datastore User**,
   **Vertex AI User**, và **Storage Object Admin** (bucket-level, trên đúng bucket vừa tạo) —
   tạo key JSON, lưu vào `video-agent-service/secrets/firestore-key.json` (thư mục `secrets/`
   đã được `.gitignore`, không commit nhầm).
3. Điền `.env` (copy từ `.env.example`) với `GCS_BUCKET`, `DRIVE_*`, `GCP_PROJECT_ID=<project id>`,
   `API_BEARER_TOKEN=<tự đặt 1 chuỗi bất kỳ>`, để trống `CLOUD_TASKS_QUEUE`.
4. Chạy:
   ```powershell
   cd video-agent-service
   docker compose up --build
   ```
5. Test (PowerShell, terminal khác):
   ```powershell
   $headers = @{ Authorization = "Bearer <API_BEARER_TOKEN trong .env>" }
   $body = @{ hotel_id = "TEST01"; folder_id = "<ID thư mục Drive test>" } | ConvertTo-Json
   $job = Invoke-RestMethod -Uri http://localhost:8080/api/jobs -Method Post -Headers $headers -Body $body -ContentType "application/json"
   $job
   Invoke-RestMethod -Uri "http://localhost:8080/api/jobs/$($job.job_id)" -Headers $headers
   ```
   Gọi lại lệnh `GET` vài lần (job chạy nền, cần thời gian Gemini phân tích) tới khi `status` = `succeeded`/`failed`.

### Cách B — dùng Firestore Emulator (không cần tạo GCP project thật)

Chỉ cần đã cài `gcloud` CLI trên máy host (không phải trong Docker):

1. Mở 1 terminal riêng, chạy emulator:
   ```powershell
   gcloud emulators firestore start --host-port=0.0.0.0:8080
   ```
2. Trong `.env`, để trống `GCP_PROJECT_ID` hoặc đặt tuỳ ý (emulator không kiểm tra), **không** cần service account key.
3. Chạy container với biến `FIRESTORE_EMULATOR_HOST` trỏ về máy host (thư viện Firestore tự nhận biến này):
   ```powershell
   docker build -t video-agent-service .
   docker run --rm -p 8081:8080 --env-file .env -e FIRESTORE_EMULATOR_HOST=host.docker.internal:8080 video-agent-service
   ```
   (dùng port `8081` cho app vì `8080` đã bị emulator chiếm trên host).
4. Test giống Cách A, đổi cổng thành `8081`.

> [!TIP]
> Muốn test riêng bước phân tích video (không qua HTTP/Docker) để debug nhanh hơn, có thể viết 1 script nhỏ
> gọi thẳng `app.pipeline.run_pipeline` sau khi set biến môi trường trong `.env` — không bắt buộc phải qua
> Docker mới xem được Gemini trả về gì.

## Deploy lên Cloud Run

Mô hình bảo mật: service deploy **public** (`--allow-unauthenticated`), giống hệt cách Cloud Run
Video Render hiện có đang chạy — không dùng Cloud Run IAM. Cả 2 nhóm endpoint tự bảo vệ bằng secret
ở tầng ứng dụng: `/api/jobs*` bằng `API_BEARER_TOKEN` (Apps Script dùng), `/internal/process-job`
bằng `INTERNAL_TASK_TOKEN` riêng (chỉ Cloud Tasks biết) — xem `app/security.py`.

Các lệnh dưới dùng PowerShell, giả sử đã `gcloud auth login` và chọn sẵn project
(`gcloud config set project <PROJECT_ID>`).

### 1. Bật API cần thiết (chạy 1 lần cho mỗi project)

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com
```

### 2. Tạo Firestore (Native mode) nếu project chưa có

```powershell
gcloud firestore databases create --location=asia-southeast1 --type=firestore-native
```

Báo lỗi "already exists" thì bỏ qua - nghĩa là project đã có Firestore rồi.

### 3. Tạo Cloud Tasks queue

```powershell
gcloud tasks queues create video-agent-jobs --location=asia-southeast1
```

### 4. Tạo bucket GCS + service account runtime riêng (least privilege, không dùng default Compute SA)

```powershell
$PROJECT_ID = gcloud config get-value project
$BUCKET = "$PROJECT_ID-video-agent-media"
gcloud storage buckets create "gs://$BUCKET" --location=asia-southeast1

gcloud iam service-accounts create video-agent-runtime --display-name "Video Agent Cloud Run runtime"
$SA = "video-agent-runtime@$PROJECT_ID.iam.gserviceaccount.com"

# roles/datastore.user, secretmanager.secretAccessor, cloudtasks.enqueuer, aiplatform.user (Gemini
# qua Vertex AI) là quyền cấp PROJECT - cần người có role Owner/IAM Admin chạy 4 lệnh dưới nếu
# tài khoản bạn chỉ có Editor (Editor cố tình KHÔNG có quyền sửa IAM, xem PLAN_vertex_ai_billing_draft.md).
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/cloudtasks.enqueuer"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/aiplatform.user"

# Quyền cấp BUCKET (không phải project) - tài khoản Editor tự làm được, không cần nhờ admin.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

### 5. Tạo secret trong Secret Manager

`API_BEARER_TOKEN`/`INTERNAL_TASK_TOKEN` tự sinh ngẫu nhiên; `DRIVE_*` phải là giá trị thật (xem
"Lấy Drive OAuth refresh token" ở trên). Không còn secret Gemini nào cần tạo — gọi qua Vertex AI
dùng luôn quyền của `$SA` ở bước 4, không cần API key.

```powershell
function New-GcloudSecret($name, $value) {
    $tmp = New-TemporaryFile
    [IO.File]::WriteAllText($tmp, $value)
    gcloud secrets create $name --data-file=$tmp
    Remove-Item $tmp
}

$apiToken = -join ((48..57)+(97..102) | Get-Random -Count 32 | ForEach-Object {[char]$_})
$internalToken = -join ((48..57)+(97..102) | Get-Random -Count 32 | ForEach-Object {[char]$_})

New-GcloudSecret "video-agent-api-bearer-token" $apiToken
New-GcloudSecret "video-agent-internal-task-token" $internalToken
New-GcloudSecret "video-agent-drive-client-id" "<DRIVE_CLIENT_ID thật>"
New-GcloudSecret "video-agent-drive-client-secret" "<DRIVE_CLIENT_SECRET thật>"
New-GcloudSecret "video-agent-drive-refresh-token" "<DRIVE_REFRESH_TOKEN thật>"

Write-Output "Luu lai - API_BEARER_TOKEN dung khi cau hinh Apps Script: $apiToken"
```

### 6. Deploy lần 1 (chưa có `PROCESS_JOB_BASE_URL` vì chưa biết URL)

```powershell
gcloud run deploy video-agent-service `
  --source . `
  --region asia-southeast1 `
  --allow-unauthenticated `
  --service-account $SA `
  --set-env-vars GEMINI_ANALYSIS_MODEL=gemini-2.5-pro,GEMINI_SYNTHESIS_MODEL=gemini-2.5-flash,GEMINI_VERTEX_LOCATION=us-central1,GCS_BUCKET=$BUCKET,GCP_PROJECT_ID=$PROJECT_ID,CLOUD_TASKS_QUEUE=video-agent-jobs,CLOUD_TASKS_LOCATION=asia-southeast1 `
  --set-secrets API_BEARER_TOKEN=video-agent-api-bearer-token:latest,INTERNAL_TASK_TOKEN=video-agent-internal-task-token:latest,DRIVE_CLIENT_ID=video-agent-drive-client-id:latest,DRIVE_CLIENT_SECRET=video-agent-drive-client-secret:latest,DRIVE_REFRESH_TOKEN=video-agent-drive-refresh-token:latest
```

> [!NOTE]
> `GEMINI_VERTEX_LOCATION=us-central1` — đã xác nhận bằng test thật rằng model Gemini 3.x/2.5
> KHÔNG có ở `asia-southeast1` qua Vertex AI (dù Cloud Run/bucket đặt ở đó vẫn gọi bình thường
> sang region khác cho riêng lệnh gọi Gemini).

> [!NOTE]
> Nếu project có org policy chặn public access (`domain restricted sharing`, hay gặp ở project thuộc
> Google Workspace/edu), lệnh trên có thể báo lỗi khi gắn `allUsers`. Khi đó cần xin ngoại lệ policy
> `iam.allowedPolicyMemberDomains` cho project, hoặc đổi hướng dùng `--no-allow-unauthenticated` +
> cấp `roles/run.invoker` cho từng caller cụ thể (phức tạp hơn cho phía Apps Script) - hỏi lại nếu rơi
> vào trường hợp này.

### 7. Lấy URL vừa deploy, cập nhật `PROCESS_JOB_BASE_URL` (deploy lần 2, chỉ update env var)

```powershell
$serviceUrl = gcloud run services describe video-agent-service --region asia-southeast1 --format "value(status.url)"
gcloud run services update video-agent-service --region asia-southeast1 --update-env-vars PROCESS_JOB_BASE_URL=$serviceUrl
```

### 8. Test thử

```powershell
Invoke-RestMethod -Uri "$serviceUrl/health"

$headers = @{ Authorization = "Bearer $apiToken" }
$body = @{ hotel_id = "TEST01"; folder_id = "<ID thư mục Drive test>" } | ConvertTo-Json
$job = Invoke-RestMethod -Uri "$serviceUrl/api/jobs" -Method Post -Headers $headers -Body $body -ContentType "application/json"
Invoke-RestMethod -Uri "$serviceUrl/api/jobs/$($job.job_id)" -Headers $headers
```

Sau khi xác nhận chạy tốt: dán `$serviceUrl` + `$apiToken` vào Apps Script (`VIDEO_AGENT_API_TOKEN`,
base URL trong `VideoAgentClient.gs` - phần này chưa code, xem `PLAN_video_agent_draft.md`).

## Endpoints

| Endpoint | Method | Auth | Mô tả |
|---|---|---|---|
| `/health` | GET | không | health check |
| `/api/jobs` | POST | Bearer (`API_BEARER_TOKEN`) | tạo job phân tích video, trả `job_id` |
| `/api/jobs/{job_id}` | GET | Bearer (`API_BEARER_TOKEN`) | poll trạng thái + kết quả |
| `/internal/process-job/{job_id}` | POST | Header `X-Internal-Task-Token` (`INTERNAL_TASK_TOKEN`) | nội bộ, chỉ Cloud Tasks gọi lại để xử lý job |
