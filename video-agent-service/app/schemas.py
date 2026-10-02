from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class HotelContext(BaseModel):
    ten_ks: Optional[str] = None
    destination: Optional[str] = None
    gia: Optional[str] = None
    giai_doan: Optional[str] = None
    benefits_raw: Optional[str] = None
    booking_note: Optional[str] = None
    # Văn phong copywriting cho video, đọc từ sheet "Rules" (scope=video_style) phía Apps
    # Script. Để trống -> dùng _DEFAULT_VIDEO_STYLE_RULES mặc định trong gemini_client.py;
    # có giá trị -> THAY THẾ HOÀN TOÀN văn phong mặc định đó.
    video_style_rules: Optional[str] = None


class CreateJobRequest(BaseModel):
    hotel_id: str
    folder_id: str
    context: HotelContext = Field(default_factory=HotelContext)
    target_duration_seconds: list[int] = Field(default_factory=lambda: [30, 60])


class AnalyzeJobRequest(BaseModel):
    """Đầu vào của POST /api/jobs/analyze-only - CHỈ nhận thứ bước phân tích thật sự dùng.

    Không có context/target_duration_seconds như CreateJobRequest: hai trường đó chỉ dùng khi
    viết kịch bản, bước phân tích video bỏ qua hoàn toàn. Khai báo thừa sẽ khiến người gọi điền
    vào rồi thắc mắc sao không có tác dụng - hãy gửi chúng ở POST /api/jobs/synthesize-only.
    """

    hotel_id: str
    folder_id: str
    # Mảng "analyses" của lần chạy trước (lấy từ GET /api/jobs/{job_id}/analyses). Gửi kèm để
    # chạy tăng dần: video nào đã có kết quả thì dùng lại, chỉ phân tích video MỚI, video đã bị
    # xoá khỏi thư mục thì kết quả cũ của nó cũng bị loại. Khớp theo "video_id" (Drive file id),
    # không theo tên - tên trùng hoặc bị đổi sẽ khớp sai. Để trống = phân tích lại toàn bộ.
    previous_analyses: Optional[list[dict[str, Any]]] = None


class SynthesizeJobRequest(BaseModel):
    hotel_id: str
    # Nguyên văn mảng "analyses" lấy từ GET /api/jobs/{job_id}/analyses - sửa tay được trước
    # khi gửi lại. Để kiểu dict thay vì model chặt: cấu trúc phân tích còn thay đổi (vd đã
    # thêm "mood", "duration", "detected_shots"), model chặt sẽ âm thầm cắt mất field mới.
    analyses: list[dict[str, Any]]
    context: HotelContext = Field(default_factory=HotelContext)
    target_duration_seconds: list[int] = Field(default_factory=lambda: [30, 60])


class CreateJobResponse(BaseModel):
    job_id: str


class VideoClip(BaseModel):
    source_video: str
    # Drive file id của video nguồn - định danh chắc chắn hơn source_video (tên file có thể
    # trùng hoặc bị đổi giữa lúc phân tích và lúc render). Do code điền từ analyses chứ không
    # nhờ model, nên luôn chính xác. Null khi analyses chưa có video_id (job cũ) hoặc khi có
    # 2 video trùng tên nên không xác định được là cái nào.
    source_video_id: Optional[str] = None
    # Dạng "mm:ss.sss" - phần giây LÀ SỐ THẬP PHÂN, lấy đúng biên chuyển cảnh dò được ở
    # scene_refiner. Không làm tròn về giây nguyên, nếu không clip sẽ dính chuyển cảnh.
    start: str
    end: str
    vibe_note: Optional[str] = None


class JobOutput(BaseModel):
    video_description: Optional[str] = None
    video_summary: Optional[str] = None
    video_srt: Optional[str] = None
    video_edit_script: Optional[list[VideoClip]] = None
    video_styling_guideline: Optional[str] = None


class JobErrorInfo(BaseModel):
    message: str


JobStatus = Literal["queued", "analyzing", "synthesizing", "succeeded", "failed"]


class JobStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    output: Optional[JobOutput] = None
    error: Optional[JobErrorInfo] = None
