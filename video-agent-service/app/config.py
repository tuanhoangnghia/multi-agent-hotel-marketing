from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Auth Apps Script -> service này
    api_bearer_token: str = ""

    # Gemini qua Developer API (KHÔNG qua Vertex AI - xem lý do trong gemini_client.build_client()).
    # GEMINI_API_KEY phải được tạo gắn với đúng project GCP (không phải tài khoản cá nhân) để
    # billing dồn về đúng Cloud Billing Account, xem PLAN_vertex_ai_billing_draft.md.
    # Model riêng cho từng bước: Pro cho bước phân tích video (cần hiểu video tốt nhất), Flash
    # cho bước tổng hợp (xử lý văn bản thuần, không cần lại sức mạnh hiểu video của Pro).
    gemini_api_key: str = ""
    gemini_analysis_model: str = "gemini-3.1-pro-preview"
    gemini_synthesis_model: str = "gemini-3.7-flash"

    # OAuth refresh token cố định để đọc Google Drive (KHÔNG dùng service account,
    # xem scripts/get_refresh_token.py để lấy 1 lần)
    drive_client_id: str = ""
    drive_client_secret: str = ""
    drive_refresh_token: str = ""

    # Firestore (lưu trạng thái job)
    gcp_project_id: str = ""
    firestore_database: str = "video-agent-db"
    firestore_collection: str = "video_agent_jobs"

    # Cloud Tasks (xử lý job bất đồng bộ) - để trống khi chạy local/dev,
    # khi đó job sẽ chạy bằng FastAPI BackgroundTasks trong cùng tiến trình.
    cloud_tasks_queue: str = ""
    cloud_tasks_location: str = "asia-southeast1"
    process_job_base_url: str = ""

    # Secret riêng để xác thực Cloud Tasks -> endpoint nội bộ /internal/process-job
    # (service deploy public, KHÔNG dùng Cloud Run IAM, để Apps Script gọi /api/jobs
    # bằng API_BEARER_TOKEN như bình thường - endpoint nội bộ tự bảo vệ bằng token này).
    internal_task_token: str = ""

    # Giới hạn xử lý (điều chỉnh được, xem PLAN_video_agent_draft.md)
    max_videos_per_job: int = 10
    max_video_duration_seconds: int = 300
    default_target_duration_min_seconds: int = 30
    default_target_duration_max_seconds: int = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
