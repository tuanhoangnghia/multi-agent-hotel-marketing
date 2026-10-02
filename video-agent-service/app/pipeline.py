import contextlib
import os
import tempfile

from . import drive_client
from . import firestore_store as store
from . import gemini_client
from . import scene_refiner
from .config import get_settings


def _run_synthesize_only(job_id: str, job: dict) -> None:
    """Chỉ chạy bước tổng hợp trên analyses gửi kèm - không tải video, không gọi Gemini Pro.

    Cùng quy ước với run_pipeline: không bao giờ raise ra ngoài, mọi lỗi ghi vào job.error.
    """
    try:
        settings = get_settings()
        analyses = job.get("analyses")
        if not analyses:
            raise ValueError("Job synthesize-only không có 'analyses' nào để tổng hợp")

        store.update_job(job_id, status="synthesizing", error=None)
        target_range = job.get("target_duration_seconds") or [
            settings.default_target_duration_min_seconds,
            settings.default_target_duration_max_seconds,
        ]
        result = gemini_client.synthesize(
            gemini_client.build_client(),
            analyses,
            job.get("context") or {},
            (target_range[0], target_range[-1]),
        )
        store.update_job(job_id, status="succeeded", output=result, error=None)
    except Exception as exc:  # noqa: BLE001 - job phải luôn kết thúc với status rõ ràng
        store.update_job(job_id, status="failed", error={"message": str(exc)}, output=None)


def run_pipeline(job_id: str) -> None:
    """Chạy toàn bộ: liệt kê video -> phân tích từng video -> tổng hợp -> ghi kết quả vào Firestore.

    Không bao giờ raise ra ngoài - mọi lỗi được ghi vào job.error để phía poll (Apps Script)
    luôn nhận được trạng thái rõ ràng thay vì job bị treo mãi ở 'processing'.
    """
    job = store.get_job(job_id)
    if job is None:
        return
    if job.get("status") in ("succeeded", "failed"):
        # Cloud Tasks đảm bảo "at-least-once", có thể gọi lại /internal/process-job cho job đã
        # xong (đã gặp thật: 1 job vừa có status=succeeded vừa còn error cũ sót từ lần gọi trước
        # đó bị lỗi) - bỏ qua để không tốn thêm 1 lượt Gemini Pro/Flash vô ích.
        return
    if job.get("synthesize_only"):
        # Job tạo từ POST /api/jobs/synthesize-only: analyses đã có sẵn trong job, bỏ qua toàn
        # bộ bước tải video + Gemini Pro. Job thường không có cờ này nên không đi vào đây.
        _run_synthesize_only(job_id, job)
        return
    try:
        settings = get_settings()
        store.update_job(job_id, status="analyzing", error=None)

        videos = drive_client.list_videos_in_folder(
            job["folder_id"], settings.max_videos_per_job, settings.max_video_duration_seconds
        )
        if not videos:
            raise ValueError(f"Không tìm thấy video nào trong thư mục Drive '{job['folder_id']}'")

        # Chạy tăng dần: video nào đã có kết quả ở lần trước thì dùng lại, chỉ phân tích video
        # MỚI. Khớp theo Drive file id chứ không theo tên - tên có thể trùng hoặc bị đổi, id thì
        # không. Video đã bị xoá khỏi thư mục tự động biến mất khỏi kết quả vì vòng lặp cuối
        # duyệt theo danh sách HIỆN TẠI của thư mục, không phải danh sách cũ.
        reusable = {
            item["video_id"]: item
            for item in (job.get("previous_analyses") or [])
            if isinstance(item, dict) and item.get("video_id")
        }
        pending = [video for video in videos if video["id"] not in reusable]

        client = gemini_client.build_client()
        fresh: dict[str, dict] = {}
        # Không mở temp dir khi không có video mới - tránh tạo thư mục thừa cho lần chạy chỉ
        # dùng lại kết quả cũ (trường hợp danh sách video không đổi).
        with contextlib.ExitStack() as stack:
            tmp_dir = stack.enter_context(tempfile.TemporaryDirectory()) if pending else ""
            for video in pending:
                video_path = os.path.join(tmp_dir, video["name"])
                drive_client.download_video(video["id"], video_path)

                analysis = gemini_client.analyze_video(client, video_path, video["name"])
                # Chuẩn hoá mốc scene ngay tại đây, khi file còn nằm trong temp dir: Gemini trả
                # mốc "mm:ss" làm tròn tới giây nên scene dễ lấn qua chuyển cảnh. scene_refiner
                # dò biên cắt thật và kẹp lại thành giây thập phân - xem app/scene_refiner.py.
                analysis = scene_refiner.refine_analysis(analysis, video_path)
                analysis["video_id"] = video["id"]
                analysis["video_name"] = video["name"]
                fresh[video["id"]] = analysis

        # Ghép theo đúng thứ tự thư mục hiện tại: video cũ lấy kết quả cũ, video mới lấy kết quả
        # vừa phân tích. Kết quả cũ của video đã xoá không lọt vào đây.
        analyses = [fresh.get(video["id"]) or reusable[video["id"]] for video in videos]

        if job.get("analyze_only"):
            # Job tạo từ POST /api/jobs/analyze-only: dừng tại đây, KHÔNG gọi synthesize (tiết
            # kiệm 1 lượt Gemini). output để None vì chưa có kịch bản - đọc kết quả phân tích
            # qua GET /api/jobs/{id}/analyses. Job thường (analyze_only=False) không đi vào đây.
            store.update_job(job_id, status="succeeded", output=None, error=None, analyses=analyses)
            return

        store.update_job(job_id, status="synthesizing")
        target_range = job.get("target_duration_seconds") or [
            settings.default_target_duration_min_seconds,
            settings.default_target_duration_max_seconds,
        ]
        result = gemini_client.synthesize(
            client, analyses, job.get("context") or {}, (target_range[0], target_range[-1])
        )
        # analyses lưu thành field RIÊNG, tuyệt đối không nhét vào output: output là hợp đồng
        # sẵn có với Apps Script, thêm khoá vào đó là đổi đầu ra của GET /api/jobs/{id}.
        # Đọc kết quả phân tích qua endpoint riêng GET /api/jobs/{id}/analyses - xem main.py.
        store.update_job(job_id, status="succeeded", output=result, error=None, analyses=analyses)
    except Exception as exc:  # noqa: BLE001 - job phải luôn kết thúc với status rõ ràng, không rớt âm thầm
        store.update_job(job_id, status="failed", error={"message": str(exc)}, output=None)
