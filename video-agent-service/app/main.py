import uuid

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException

from . import firestore_store as store
from . import tasks
from .config import get_settings
from .pipeline import run_pipeline
from .schemas import (
    AnalyzeJobRequest,
    CreateJobRequest,
    CreateJobResponse,
    JobStatusResponse,
    SynthesizeJobRequest,
)
from .security import verify_bearer_token, verify_internal_task_token

app = FastAPI(title="Video Agent Service", version="0.1.0")


@app.get("/health")
def health() -> dict:
    # KHÔNG dùng "/healthz" - Cloud Run/Google frontend chặn path này ở tầng hạ tầng,
    # không bao giờ forward vào container (xác nhận bằng test thật, xem ARCHITECTURE.md).
    return {"status": "ok"}


@app.post("/api/jobs", response_model=CreateJobResponse, dependencies=[Depends(verify_bearer_token)])
def create_job(payload: CreateJobRequest, background_tasks: BackgroundTasks) -> CreateJobResponse:
    settings = get_settings()
    job_id = uuid.uuid4().hex
    store.create_job(
        job_id,
        payload.hotel_id,
        payload.folder_id,
        payload.context.model_dump(),
        payload.target_duration_seconds,
    )
    if settings.cloud_tasks_queue:
        tasks.enqueue_process_job(job_id)
    else:
        # Local/dev: không có Cloud Tasks -> chạy nền ngay trong tiến trình hiện tại.
        background_tasks.add_task(run_pipeline, job_id)
    return CreateJobResponse(job_id=job_id)


@app.post(
    "/api/jobs/analyze-only",
    response_model=CreateJobResponse,
    dependencies=[Depends(verify_bearer_token)],
)
def create_analyze_only_job(payload: AnalyzeJobRequest, background_tasks: BackgroundTasks) -> CreateJobResponse:
    """Tạo job CHỈ chạy analyze_video cho từng video, không chạy synthesize.

    Gửi kèm previous_analyses (mảng "analyses" của lần trước) để chạy TĂNG DẦN: chỉ phân tích
    video mới xuất hiện trong thư mục, dùng lại kết quả cũ cho video đã có, loại kết quả của
    video đã bị xoá. Khớp theo Drive file id. Danh sách video không đổi thì không gọi Gemini
    lần nào, trả thẳng kết quả cũ.

    Chỉ nhận hotel_id + folder_id: bước phân tích không đọc context/target_duration_seconds,
    hai trường đó thuộc về POST /api/jobs/synthesize-only. Lưu {} và [] xuống Firestore cho
    đúng thực tế job này không có hai giá trị đó, thay vì lưu giá trị giả gây hiểu nhầm.

    Cố ý viết tách khỏi create_job() thay vì gộp chung: POST /api/jobs đã được tích hợp vào
    ứng dụng khác nên không được đụng vào. Đọc kết quả qua GET /api/jobs/{job_id}/analyses.
    """
    settings = get_settings()
    job_id = uuid.uuid4().hex
    store.create_job(
        job_id,
        payload.hotel_id,
        payload.folder_id,
        {},
        [],
        analyze_only=True,
        previous_analyses=payload.previous_analyses,
    )
    if settings.cloud_tasks_queue:
        tasks.enqueue_process_job(job_id)
    else:
        background_tasks.add_task(run_pipeline, job_id)
    return CreateJobResponse(job_id=job_id)


@app.post(
    "/api/jobs/synthesize-only",
    response_model=CreateJobResponse,
    dependencies=[Depends(verify_bearer_token)],
)
def create_synthesize_only_job(
    payload: SynthesizeJobRequest, background_tasks: BackgroundTasks
) -> CreateJobResponse:
    """Tạo job CHỈ chạy synthesize trên analyses gửi kèm, bỏ hẳn bước tải + phân tích video.

    Đầu vào là nguyên văn mảng "analyses" của GET /api/jobs/{job_id}/analyses - sửa tay được
    trước khi gửi lại. Đọc kết quả ở GET /api/jobs/{job_id} như job thường.
    Cố ý viết tách khỏi create_job(): POST /api/jobs đã tích hợp vào ứng dụng khác.
    """
    settings = get_settings()
    job_id = uuid.uuid4().hex
    store.create_synthesize_job(
        job_id,
        payload.hotel_id,
        payload.analyses,
        payload.context.model_dump(),
        payload.target_duration_seconds,
    )
    if settings.cloud_tasks_queue:
        tasks.enqueue_process_job(job_id)
    else:
        background_tasks.add_task(run_pipeline, job_id)
    return CreateJobResponse(job_id=job_id)


@app.get("/api/jobs/{job_id}", response_model=JobStatusResponse, dependencies=[Depends(verify_bearer_token)])
def get_job_status(job_id: str) -> JobStatusResponse:
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job không tồn tại")
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        output=job.get("output"),
        error=job.get("error"),
    )


@app.get("/api/jobs/{job_id}/analyses", dependencies=[Depends(verify_bearer_token)])
def get_job_analyses(job_id: str) -> dict:
    """Xem TOÀN BỘ kết quả của 1 job: trạng thái, kịch bản tổng hợp, và phân tích từng video.

    Đây là endpoint "xem tất cả" - trả cùng 1 dạng {job_id, status, output, error, analyses}
    cho MỌI loại job (đầy đủ / analyze-only / synthesize-only), gọi 1 lần là đủ, không phải
    ghép kết quả từ 2 endpoint. Trường nào job đó chưa có thì là null chứ không biến mất.

    GET /api/jobs/{job_id} cố ý giữ nguyên hợp đồng cũ (chỉ job_id/status/output/error) vì đã
    tích hợp vào Apps Script và Video Render - mở rộng ở đây thay vì sửa bên đó.

    CỐ Ý không khai báo response_model: cấu trúc phân tích còn thay đổi (vd đã thêm "mood"),
    model chặt sẽ âm thầm cắt mất field mới - đã xảy ra đúng như vậy với vibe_note trước đây.
    """
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job không tồn tại")
    return {
        "job_id": job_id,
        "status": job["status"],
        "output": job.get("output"),
        "error": job.get("error"),
        "analyses": job.get("analyses"),
    }


@app.post("/internal/process-job/{job_id}", dependencies=[Depends(verify_internal_task_token)])
def process_job_internal(job_id: str) -> dict:
    # Chỉ Cloud Tasks (biết INTERNAL_TASK_TOKEN) mới gọi được endpoint này - xem README.md.
    run_pipeline(job_id)
    return {"ok": True}
