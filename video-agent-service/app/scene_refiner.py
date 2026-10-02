"""Chuẩn hoá mốc thời gian scene của Gemini bằng cách dò cắt cảnh THẬT trong file video.

Vì sao cần bước này: analyze_video() trả mốc dạng "mm:ss" - làm tròn tới giây - nên một scene
rất dễ lấn sang cú chuyển cảnh kế bên. Cắt theo mốc đó sẽ dính khoảnh khắc chuyển cảnh ngay
giữa clip. Ở đây ta dò biên cắt thật bằng PySceneDetect (độ chính xác tới từng frame), rồi kẹp
mốc của Gemini vào trong đúng 1 cú quay liên tục -> đảm bảo không clip nào chứa chuyển cảnh.

Thuật toán dò: AdaptiveDetector - so sánh khác biệt nội dung giữa các frame liên tiếp rồi lấy
ngưỡng theo trung bình trượt của cửa sổ lân cận, thay vì một ngưỡng cố định như ContentDetector.
Chọn nó vì video khách sạn nhiều cảnh flycam/pan chậm: ngưỡng cố định sẽ báo nhầm chuyển cảnh
khi máy quay lia nhanh, còn ngưỡng thích ứng thì tự nới ra ở đoạn chuyển động mạnh.
"""

import math
import re
from typing import Any, Optional

_MIN_SEGMENT_SECONDS = 0.5
# Model hay làm tròn mốc về giây nguyên, tức lệch tối đa 0.5s mỗi đầu. Cho phép 1.0s để bắt lại
# được cả trường hợp lệch hơn, nhưng vẫn nhỏ hơn độ dài scene ngắn nhất nên không khớp nhầm sang
# scene kế bên.
_SNAP_TOLERANCE_SECONDS = 1.0


def _floor_ms(seconds: float) -> float:
    return math.floor(seconds * 1000) / 1000


def _ceil_ms(seconds: float) -> float:
    return math.ceil(seconds * 1000) / 1000


def _parse_timestamp(value: Any) -> Optional[float]:
    """Đổi mốc thời gian của Gemini sang giây (float). Chấp nhận "mm:ss", "hh:mm:ss", "12.48", 12.48."""
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    text = value.strip().replace(",", ".")
    if not text:
        return None
    try:
        parts = [float(p) for p in text.split(":")]
    except ValueError:
        return None
    seconds = 0.0
    for part in parts:  # "ss" | "mm:ss" | "hh:mm:ss"
        seconds = seconds * 60 + part
    return seconds


def detect_shot_boundaries(video_path: str) -> list[tuple[float, float]]:
    """Trả về danh sách (start, end) tính bằng giây của từng cú quay liên tục trong video."""
    # Import tại chỗ: scenedetect/opencv nặng, chỉ nạp khi thực sự dò cảnh để không làm chậm
    # cold start của Cloud Run cho các request không đụng tới video.
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    video = open_video(video_path)
    manager = SceneManager()
    manager.auto_downscale = True  # giảm độ phân giải khi phân tích -> nhanh hơn nhiều, độ chính xác biên không đổi
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video, show_progress=False)
    return [(start.seconds, end.seconds) for start, end in manager.get_scene_list()]


def _dominant_shot(
    start: float, end: float, shots: list[tuple[float, float]]
) -> Optional[tuple[float, float]]:
    """Cú quay chồng lấn nhiều nhất với khoảng [start, end]."""
    best: Optional[tuple[float, float]] = None
    best_overlap = 0.0
    for shot_start, shot_end in shots:
        overlap = min(end, shot_end) - max(start, shot_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best = (shot_start, shot_end)
    return best


def refine_scenes(scenes: list[dict], shots: list[tuple[float, float]]) -> list[dict]:
    """Kẹp từng scene của Gemini vào trong đúng 1 cú quay, trả mốc dạng giây thập phân.

    Giao [scene] với [cú quay chồng lấn nhiều nhất] thay vì lấy trọn cú quay: nếu Gemini chia 1
    cú quay dài thành 2 scene khác mô tả thì vẫn giữ được sự phân chia đó, mà vẫn chắc chắn
    không scene nào bắc ngang biên cắt. Giao quá ngắn (do Gemini làm tròn lệch hẳn) thì lùi về
    lấy trọn cú quay - thà lấy rộng đúng 1 cú quay còn hơn trả về mẩu vụn không dùng được.
    """
    if not shots:
        return scenes

    refined: list[dict] = []
    for scene in scenes:
        start = _parse_timestamp(scene.get("start"))
        end = _parse_timestamp(scene.get("end"))
        if start is None or end is None or end <= start:
            continue

        shot = _dominant_shot(start, end, shots)
        if shot is None:  # không chồng lấn cú quay nào -> mốc của Gemini vô nghĩa, bỏ
            continue

        new_start = max(start, shot[0])
        new_end = min(end, shot[1])
        if new_end - new_start < _MIN_SEGMENT_SECONDS:
            new_start, new_end = shot

        # Làm tròn start LÊN và end XUỐNG (mốc ms), không dùng round(): round() có thể đẩy start
        # ra trước biên cắt vài phần nghìn giây - đúng lỗi dính chuyển cảnh mà bước này sinh ra
        # để tránh. Ví dụ biên thật 6.2333s, round() cho 6.233s tức lùi vào cú quay trước.
        start_ms = _ceil_ms(new_start)
        end_ms = _floor_ms(new_end)
        item = dict(scene)
        item["start"] = start_ms
        item["end"] = end_ms
        item["duration"] = round(end_ms - start_ms, 3)
        refined.append(item)
    return refined


def format_timestamp(seconds: float) -> str:
    """Đổi giây thập phân sang "mm:ss.sss" - giữ nguyên phần thập phân, KHÔNG làm tròn tới giây."""
    seconds = max(seconds, 0.0)
    minutes = int(seconds // 60)
    return f"{minutes:02d}:{seconds - minutes * 60:06.3f}"


def has_burned_in_text(scene: dict) -> bool:
    return bool(scene.get("has_burned_in_text"))


def drop_scenes_with_text(analyses: list[dict]) -> list[dict]:
    """Bỏ hẳn scene có chữ cháy sẵn khỏi dữ liệu phân tích trước khi đưa vào prompt.

    Phòng bệnh hơn chữa: model không chọn được thứ nó không nhìn thấy. Vẫn giữ thêm bước lọc
    ở snap_clips_to_scenes() làm lưới an toàn phòng khi model tự bịa mốc.
    """
    result = []
    for analysis in analyses:
        item = dict(analysis)
        scenes = analysis.get("scenes")
        if isinstance(scenes, list):
            item["scenes"] = [s for s in scenes if isinstance(s, dict) and not has_burned_in_text(s)]
        result.append(item)
    return result


def _video_id_by_name(analyses: list[dict]) -> dict[str, Optional[str]]:
    """Tên file -> Drive file id, để gắn source_video_id cho clip.

    Model chỉ nhắc tới video bằng tên, nên phải tra ngược sang id ở đây. Hai video TRÙNG TÊN
    thì không xác định được là cái nào -> trả None cho tên đó, thà bỏ trống còn hơn gắn nhầm id.
    """
    mapping: dict[str, Optional[str]] = {}
    for analysis in analyses:
        if not isinstance(analysis, dict):
            continue
        name = analysis.get("video_name")
        if not name:
            continue
        video_id = analysis.get("video_id")
        mapping[name] = None if name in mapping and mapping[name] != video_id else video_id
    return mapping


def _scene_bounds_by_video(analyses: list[dict]) -> dict[str, list[tuple[float, float, bool]]]:
    mapping: dict[str, list[tuple[float, float, bool]]] = {}
    for analysis in analyses:
        name = analysis.get("video_name")
        scenes = analysis.get("scenes")
        if not name or not isinstance(scenes, list):
            continue
        bounds = []
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            start = _parse_timestamp(scene.get("start"))
            end = _parse_timestamp(scene.get("end"))
            if start is not None and end is not None and end > start:
                bounds.append((start, end, has_burned_in_text(scene)))
        if bounds:
            mapping[name] = bounds
    return mapping


def snap_clips_to_scenes(
    clips: list, analyses: list[dict], tolerance: float = _SNAP_TOLERANCE_SECONDS
) -> tuple[list, list[int]]:
    """Kéo mốc clip về ĐÚNG biên scene, LOẠI clip dính scene có chữ, trả (clip giữ lại, chỉ số gốc).

    Hai việc, đều là thứ prompt không bảo đảm được nên phải làm bằng code:

    1. Snap mốc: prompt yêu cầu chép nguyên mốc scene và giữ thập phân, nhưng model vẫn hay làm
       tròn về giây nguyên. Khớp lại clip với scene gần nhất của đúng video đó rồi lấy con số
       CHÍNH XÁC của scene - lấy lại được độ chính xác model đánh rơi.

    2. Loại chữ cháy sẵn: chỉ giữ clip khớp được với 1 scene KHÔNG có chữ. Clip khớp scene có
       chữ, hoặc không khớp scene nào (model tự bịa mốc, không kiểm chứng được là sạch), đều bị
       loại - chữ của ta đè lên chữ có sẵn là hỏng sản phẩm.

    Trả kèm chỉ số gốc để rebuild_srt() bỏ đúng những dòng phụ đề tương ứng.
    """
    by_video = _scene_bounds_by_video(analyses)
    ids_by_name = _video_id_by_name(analyses)
    kept: list = []
    kept_indices: list[int] = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            continue
        start = _parse_timestamp(clip.get("start"))
        end = _parse_timestamp(clip.get("end"))
        if start is None or end is None:
            continue

        best: Optional[tuple[float, float, bool]] = None
        best_distance: Optional[float] = None
        for scene_start, scene_end, scene_has_text in by_video.get(clip.get("source_video"), []):
            if abs(scene_start - start) > tolerance or abs(scene_end - end) > tolerance:
                continue
            distance = abs(scene_start - start) + abs(scene_end - end)
            if best_distance is None or distance < best_distance:
                best, best_distance = (scene_start, scene_end, scene_has_text), distance

        if best is None or best[2]:
            continue

        item = dict(clip)
        item["start"] = format_timestamp(best[0])
        item["end"] = format_timestamp(best[1])
        # Gắn Drive file id từ analyses thay vì nhờ model điền: code tra bảng thì luôn đúng,
        # còn model thì có thể chép sai chuỗi id dài. Không tra được thì để trống.
        video_id = ids_by_name.get(clip.get("source_video"))
        if video_id:
            item["source_video_id"] = video_id
        kept.append(item)
        kept_indices.append(index)
    return kept, kept_indices


def _srt_timestamp(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    return f"{hours:02d}:{minutes:02d}:{seconds - hours * 3600 - minutes * 60:06.3f}".replace(".", ",")


def rebuild_srt(srt_text: str, clips: list, keep_indices: Optional[list[int]] = None) -> str:
    """Tính lại mốc thời gian SRT từ độ dài THẬT của từng clip, giữ nguyên phần chữ.

    Sau khi snap_clips_to_scenes() chỉnh mốc clip, độ dài clip đổi vài phần trăm giây so với lúc
    model viết SRT - để nguyên thì chữ sẽ lệch khỏi hình. Ở đây mốc SRT được suy ra từ clip nên
    hai bên luôn khớp tuyệt đối. Số cue không khớp số clip thì trả nguyên bản, không đoán bừa.

    keep_indices: chỉ số các clip còn được giữ sau khi lọc scene có chữ - dòng phụ đề của clip
    bị loại phải bỏ theo, nếu không phần chữ sẽ lệch hẳn sang cảnh khác.
    """
    blocks = [b for b in re.split(r"\n\s*\n", srt_text.strip()) if b.strip()]
    if keep_indices is not None:
        if any(i >= len(blocks) for i in keep_indices):
            return srt_text
        blocks = [blocks[i] for i in keep_indices]
    durations = []
    for clip in clips:
        start = _parse_timestamp(clip.get("start")) if isinstance(clip, dict) else None
        end = _parse_timestamp(clip.get("end")) if isinstance(clip, dict) else None
        if start is None or end is None or end <= start:
            return srt_text
        durations.append(end - start)
    if not blocks or len(blocks) != len(durations):
        return srt_text

    rebuilt = []
    cursor = 0.0
    for index, (block, duration) in enumerate(zip(blocks, durations), start=1):
        lines = block.splitlines()
        # Bỏ dòng số thứ tự và dòng mốc thời gian cũ, giữ lại đúng phần chữ.
        text_lines = [line for line in lines if "-->" not in line and not line.strip().isdigit()]
        if not text_lines:
            return srt_text
        rebuilt.append(
            f"{index}\n{_srt_timestamp(cursor)} --> {_srt_timestamp(cursor + duration)}\n"
            + "\n".join(text_lines)
        )
        cursor += duration
    return "\n\n".join(rebuilt)


def refine_analysis(analysis: dict, video_path: str) -> dict:
    """Chuẩn hoá scenes của 1 kết quả analyze_video. Không bao giờ raise.

    Dò cảnh hỏng (codec lạ, file lỗi) thì giữ nguyên kết quả gốc: mốc kém chính xác vẫn tốt hơn
    là làm chết cả job vốn đã tốn nhiều lượt Gemini.
    """
    scenes = analysis.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return analysis
    try:
        shots = detect_shot_boundaries(video_path)
    except Exception as error:  # noqa: BLE001 - dò cảnh là bước tăng cường, không được làm hỏng job
        result = dict(analysis)
        result["scene_detection_error"] = str(error)
        return result

    result = dict(analysis)
    result["scenes"] = refine_scenes(scenes, shots)
    # KHÔNG trả kèm danh sách biên cắt thô: không nơi nào trong code đọc nó, mà nó vẫn bị nạp
    # vào prompt synthesize (tốn ~944 token cho 4 video) và tệ hơn là model có thể tưởng đó
    # cũng là mốc dùng được rồi lấy start/end từ đó thay vì từ scenes.
    return result
