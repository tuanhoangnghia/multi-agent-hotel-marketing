import json
import re
import time
from typing import Any

from google import genai

from . import scene_refiner
from .config import get_settings

_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)


def _generate_json_with_retry(client: genai.Client, model: str, contents: list[Any]) -> dict:
    """Gọi Gemini và parse JSON, sinh lại khi lỗi mạng tạm thời HOẶC khi model trả JSON hỏng.

    response_mime_type buộc Gemini trả JSON hợp lệ, nhưng thực tế vẫn lọt phản hồi sai cú pháp
    (đã gặp: "Expecting ',' delimiter") - lỗi này xảy ra sau khi API trả 200 nên phải coi là
    transient và sinh lại, nếu không 1 video hỏng sẽ giết cả job.
    """
    last_error: Exception | None = None
    last_text = ""
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=model,
                contents=contents,
                config={"response_mime_type": "application/json"},
            )
            last_text = response.text or ""
            return _extract_json(last_text)
        except ValueError as error:  # gồm json.JSONDecodeError - model trả JSON hỏng
            last_error = error
        except Exception as error:
            message = str(error)
            transient = any(marker in message for marker in ("429", "500", "502", "503", "504", "UNAVAILABLE"))
            if not transient:
                raise
            last_error = error
        if attempt < 2:
            time.sleep(2**attempt)
    if last_text:
        raise ValueError(
            f"Gemini không trả JSON hợp lệ sau 3 lần thử ({last_error}): {last_text[:300]!r}"
        ) from last_error
    raise last_error


def build_client() -> genai.Client:
    """Dùng Gemini Developer API (api_key), KHÔNG dùng Vertex AI.

    Lý do đổi lại từ Vertex AI (2026-08-26): Gemini 3.x (model thay thế được Google khuyến nghị
    cho 2.5 Pro/Flash, dự kiến ngừng hỗ trợ không sớm hơn 16/10/2026) đã xác nhận CHƯA có quyền
    truy cập qua Vertex AI cho project này (404 "does not have access", không có quota bucket nào
    được tạo - khác hẳn Claude, dấu hiệu vẫn đang trong giai đoạn allowlist hạn chế). Gemini 3.x
    lại gọi được ngay qua Developer API. GEMINI_API_KEY vẫn dồn billing về đúng project/Cloud
    Billing Account (xác nhận: "The API key itself is free; the bill belongs to the project and
    its linked Cloud Billing account" - key được tạo gắn với đúng project GCP, không phải tài
    khoản cá nhân, nên vẫn đạt mục tiêu 1 hoá đơn GCP duy nhất).
    """
    settings = get_settings()
    if not settings.gemini_api_key:
        raise RuntimeError("Thiếu GEMINI_API_KEY")
    return genai.Client(api_key=settings.gemini_api_key)


def _extract_json(text: str) -> dict:
    match = _JSON_BLOCK_RE.search(text)
    if not match:
        raise ValueError(f"Không tìm thấy JSON hợp lệ trong phản hồi Gemini: {text[:300]!r}")
    return json.loads(match.group(0))


def _wait_until_active(
    client: genai.Client,
    uploaded_file: Any,
    timeout_seconds: int = 300,
    poll_interval: int = 5,
) -> Any:
    started = time.monotonic()
    file_ref = uploaded_file
    while file_ref.state.name == "PROCESSING":
        if time.monotonic() - started > timeout_seconds:
            raise TimeoutError(f"Video '{uploaded_file.name}' xử lý ở Gemini quá {timeout_seconds}s")
        time.sleep(poll_interval)
        file_ref = client.files.get(name=uploaded_file.name)
    if file_ref.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini file '{uploaded_file.name}' ở trạng thái không hợp lệ: {file_ref.state.name}")
    return file_ref


def _upload_with_retry(client: genai.Client, video_path: str) -> Any:
    """Upload video lên Gemini Files API và chờ ACTIVE, thử lại khi thất bại.

    Đã gặp 400 "Upload has already been terminated" - lỗi nhất thời của phiên resumable upload,
    không phải lỗi vĩnh viễn, nên ở đây KHÔNG lọc theo mã lỗi transient như _generate_json_with_retry:
    mọi thất bại đều đáng thử lại vì upload không tính vào quota generate_content.
    Xoá file dở dang của lần hỏng trước để không bỏ rác lại trên Files API.
    """
    for attempt in range(3):
        uploaded = None
        try:
            uploaded = client.files.upload(file=video_path)
            return _wait_until_active(client, uploaded)
        except Exception:
            if uploaded is not None:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception:  # noqa: BLE001 - dọn dẹp best-effort, không được che lỗi gốc
                    pass
            if attempt == 2:
                raise
            time.sleep(2**attempt)


def analyze_video(client: genai.Client, video_path: str, video_name: str) -> dict:
    """Phân tích 1 video: cảnh quay, cảm giác, tiện ích, điểm bán hàng.

    Upload thẳng file local qua Gemini Files API (client.files.upload) - cách này chỉ hoạt động
    ở chế độ Developer API (api_key), KHÔNG hoạt động ở Vertex AI. Xem build_client().
    """
    settings = get_settings()
    uploaded = _upload_with_retry(client, video_path)
    prompt = (
        "Bạn là chuyên gia phân tích video cho CHV Travel - công ty bán tour/kỳ nghỉ dùng khách sạn làm điểm đến, "
        "không phải khách sạn tự quảng cáo. Nhiệm vụ của bạn là thu thập nguyên liệu để bước sau viết kịch bản "
        "khiến khách MUỐN CÓ kỳ nghỉ đó, nên ngoài việc mô tả cảnh còn cần bắt được CẢM GIÁC cảnh đó gợi lên.\n"
        "NGÔN NGỮ: mọi giá trị chữ trong JSON trả về (description, mood, amenities, selling_points) "
        "BẮT BUỘC viết bằng TIẾNG VIỆT có dấu. Kể cả khi video có chữ/lời tiếng Anh trên hình thì vẫn "
        "phải mô tả bằng tiếng Việt - tuyệt đối không trả về tiếng Anh, vì bước sau viết kịch bản tiếng Việt.\n"
        f'Xem kỹ video "{video_name}" và trả về DUY NHẤT 1 JSON (không thêm giải thích) với các trường:\n'
        '- "scenes": danh sách {"start": "mm:ss", "end": "mm:ss", "description": "...", "mood": "...", "has_burned_in_text": true/false}\n'
        "  Mỗi phần tử phải là 1 cú quay LIÊN TỤC - cắt đúng tại mốc chuyển cảnh của video gốc, "
        "không gộp 2 cú quay vào cùng 1 scene, vì bước dựng sau sẽ dựa vào mốc này để tránh cắt trúng chỗ chuyển cảnh.\n"
        '  "mood" = cảm giác/khao khát cảnh này gợi lên cho người xem (vd: "riêng tư, được ở một mình với thiên nhiên", '
        '"sống chậm lại, không vội vã", "gắn kết với người thương") - không phải mô tả vật lý, mà là thứ khách CẢM NHẬN được.\n'
        '  "has_burned_in_text" = true nếu trong khung hình có chữ/phụ đề/logo/watermark cháy sẵn, false nếu hình sạch.\n'
        '- "amenities": danh sách tiện ích nhận diện được (hồ bơi, spa, nhà hàng...)\n'
        '- "selling_points": danh sách điểm bán hàng nổi bật'
        # Không xin "spoken_transcript" nữa: không nơi nào trong code đọc nó, và thực tế 12/12
        # video đã chạy đều trả về rỗng (video khách sạn là nhạc nền không lời). Cần dùng lại
        # thì thêm trường vào đây VÀ thêm quy tắc dùng nó ở prompt synthesize.
    )
    return _generate_json_with_retry(client, settings.gemini_analysis_model, [uploaded, prompt])


# Văn phong copywriting mặc định cho video - dùng khi hotel_context không có video_style_rules
# (tức sheet "Rules" scope=video_style đang để trống). Có thể override toàn bộ khối này qua
# context của job, không cần sửa code/redeploy - xem HotelContext.video_style_rules.
_DEFAULT_VIDEO_STYLE_RULES = (
    "NGUYÊN TẮC QUAN TRỌNG NHẤT - chi phối MỌI quyết định viết, ưu tiên cao hơn tất cả các quy tắc khác:\n"
    '"Không làm video để giới thiệu khách sạn. Làm video để khiến khách muốn có kỳ nghỉ đó."\n'
    "Khách sạn chỉ là bối cảnh - nhân vật chính là CẢM GIÁC khách sẽ có trong kỳ nghỉ đó (được nghỉ ngơi thật "
    "sự, được sống chậm lại, được ở bên người mình thương, được là chính mình). Trước khi viết mỗi câu, tự hỏi: "
    "\"câu này khiến khách sạn nghe hay hơn, hay khiến khách MUỐN CÓ kỳ nghỉ này hơn?\" - nếu chỉ làm vế đầu thì viết lại.\n\n"

    "PHONG CÁCH CHV (bắt buộc tuân thủ toàn bộ, không được vi phạm dù chỉ 1 điểm):\n"
    "1. Sang nhưng không sáo rỗng - sang trọng đến từ sự tiết chế và chọn lọc chi tiết, không phải từ tính từ to tát.\n"
    "2. Có cảm xúc nhưng phải bán được hàng - mỗi câu chạm cảm xúc đều phải dẫn khách gần hơn tới quyết định "
    "đặt chỗ, không cảm xúc suông, không thơ hoá vô nghĩa.\n"
    "3. Ngắn, dễ đọc - câu ngắn, không câu phức, không giải thích dài dòng.\n"
    "4. Không viết kiểu brochure khách sạn - tuyệt đối không liệt kê tiện ích ('5 sao', 'all inclusive', "
    "'hồ bơi vô cực'), không kể tính năng phòng.\n"
    "5. Không nhồi quá nhiều USP - chọn ĐÚNG 1 cảm giác chủ đạo xuyên suốt cả kịch bản, không cố nhét hết "
    "mọi điểm mạnh của khách sạn vào.\n"
    "6. Tránh câu chữ quảng cáo đại trà - CẤM DÙNG các cụm đã bị lạm dụng tới mức vô nghĩa: "
    '"thiên đường nghỉ dưỡng", "đẳng cấp 5 sao", "sang trọng bậc nhất", "trải nghiệm khó quên/tuyệt vời", '
    '"không gian xanh mát trong lành", "dịch vụ đẳng cấp quốc tế", "tọa lạc tại vị trí đắc địa", "quý khách", '
    '"trải nghiệm đẳng cấp", "thế giới riêng", "chốn bình yên" - nếu định dùng cụm nào nghe quen tai như quảng '
    "cáo đại trà, hãy viết lại theo cách cụ thể/riêng của khách sạn này.\n"
    "7. Ưu tiên insight và cảm giác khách hàng nhận được hơn là sự thật về khách sạn - insight trả lời câu hỏi "
    '"khách đang thiếu gì trong nhịp sống hiện tại mà kỳ nghỉ này bù đắp được", không phải "khách sạn có gì".\n\n'

    "CÁC QUY TẮC BỔ SUNG:\n"
    "- TONE GIỌNG: Sang trọng, tĩnh lặng nhưng thủ thỉ như người quen, không phải giọng MC quảng cáo.\n"
    "- CTA NHẸ NHÀNG (Phần cuối): Chỉ để Tên thương hiệu + Tên Đại lý (Ví dụ: CHV TRAVEL - Inbox để chọn ngày đẹp). BỎ hotline, BỎ chữ 'đặt ngay'.\n"
    "- KHÔNG EMOJI: Sang trọng là sự kìm nén. Ngôn từ súc tích, ngắn gọn.\n\n"

    "THAM KHẢO CẤU TRÚC KỊCH BẢN (Hãy linh hoạt áp dụng theo dữ liệu khách sạn nhưng giữ tinh thần này):\n"
    "0-3s [HOOK] Cảnh mở cực rộng (ví dụ: thiên nhiên hùng vĩ) -> Text: 'CÓ NHỮNG NƠI, CHỈ CẦN ĐẾN LÀ MUỐN Ở LẠI.'\n"
    "3-7s [ĐIỂM CHẠM 1] Cảnh tiêu biểu -> Text: 'Bơi giữa một thung lũng đầy mây'\n"
    "7-11s [ĐIỂM CHẠM 2] -> Text: 'Thức dậy giữa màu xanh...'\n"
    "11-15s [ĐIỂM CHẠM 3] -> Text: 'Đi thật chậm. Nghe rừng nhiều hơn.'\n"
    "15-19s [KHOẢNH KHẮC] Cảnh nghỉ ngơi tĩnh lặng -> Text: 'Và chẳng cần vội đi đâu cả.'\n"
    "19-23s [SALES] Cảnh hero đẹp nhất -> Text: '[Tên Khách Sạn]\\nTừ [Giá] triệu/đêm\\n[Tên Đại Lý]\\nInbox [Tên Đại Lý] để chọn ngày đẹp'"
)


def synthesize(
    client: genai.Client,
    per_video_analyses: list[dict],
    hotel_context: dict,
    target_duration_range: tuple[int, int],
) -> dict:
    """Tổng hợp kết quả phân tích N video thành video_description/video_srt/video_edit_script."""
    settings = get_settings()
    duration_min, duration_max = target_duration_range
    hotel_context = hotel_context or {}
    style_rules = hotel_context.get("video_style_rules") or _DEFAULT_VIDEO_STYLE_RULES
    hotel_info = {k: v for k, v in hotel_context.items() if k != "video_style_rules"}
    # Bỏ hẳn scene có chữ cháy sẵn khỏi dữ liệu đưa vào prompt - model không chọn được thứ nó
    # không nhìn thấy. Đây là lớp phòng bệnh; lớp lọc thứ hai nằm ở snap_clips_to_scenes().
    clean_analyses = scene_refiner.drop_scenes_with_text(per_video_analyses)

    prompt = (
        "Bạn là Copywriter kiêm Biên tập viên video cho CHV Travel - công ty bán TOUR và KỲ NGHỈ, dùng khách sạn "
        "làm điểm đến chứ không phải khách sạn tự quảng cáo chính mình. Vì vậy đây KHÔNG phải video giới thiệu "
        "khách sạn, mà là video bán 1 kỳ nghỉ.\n"
        "NGÔN NGỮ: toàn bộ chữ trả về (video_description, video_summary, video_srt, vibe_note, "
        "video_styling_guideline) BẮT BUỘC bằng TIẾNG VIỆT có dấu - khách hàng là người Việt. "
        "Nếu dữ liệu phân tích phía dưới có phần nào bằng tiếng Anh thì tự dịch sang tiếng Việt khi viết, "
        "tuyệt đối không trả về tiếng Anh.\n"
        f"Dưới đây là kết quả phân tích {len(clean_analyses)} video thô của cùng 1 khách sạn (định dạng JSON). "
        "Các scene có chữ/logo cháy sẵn trên hình ĐÃ BỊ LOẠI khỏi danh sách này, nên mọi scene bạn thấy đều dùng được:\n"
        f"{json.dumps(clean_analyses, ensure_ascii=False)}\n\n"
        f"Thông tin bổ sung về khách sạn (có thể thiếu 1 số trường): "
        f"{json.dumps(hotel_info, ensure_ascii=False)}\n\n"

        "CÁCH DÙNG 'Thông tin bổ sung về khách sạn' Ở TRÊN - BẮT BUỘC, không được bỏ qua nếu có dữ liệu:\n"
        "- Nếu có 'gia': cảnh/dòng CUỐI CÙNG của video_srt phải nêu rõ mức giá kèm CTA đặt phòng qua CHV "
        "(VD: '[Tên khách sạn]\\nTừ [gia]\\nCHV TRAVEL\\nInbox để chọn ngày đẹp'). Nếu mức giá này rõ ràng là "
        "ưu đãi hấp dẫn (từ ngữ cảnh 'giai_doan'/'benefits_raw' toát lên đây là giá tốt/khuyến mãi), nhấn mạnh rõ "
        "hơn (VD thêm chữ 'Giá ưu đãi' trước mức giá) thay vì chỉ nêu giá suông.\n"
        "- Nếu có 'benefits_raw': chọn ĐÚNG 1 dịch vụ/quyền lợi nổi bật nhất (không liệt kê hết) để nhắc ngắn gọn "
        "ngay trước hoặc cùng dòng giá ở cảnh kết (VD: 'kèm ăn sáng 2 người') - không đưa benefits_raw vào giữa "
        "kịch bản, chỉ dùng ở cảnh kết cùng giá.\n"
        "- Nếu KHÔNG có 'gia' (trống): cảnh/dòng cuối chỉ cần CTA chung 'CHV TRAVEL\\nInbox để đặt phòng' hoặc "
        "'CHV TRAVEL\\nInbox để chọn ngày đẹp' - TUYỆT ĐỐI không tự bịa ra mức giá hay dịch vụ không có trong dữ liệu.\n"
        "- video_description cũng nên phản ánh các thông tin này khi có dữ liệu (VD: nhắc khoảng thời gian áp dụng "
        "nếu có 'giai_doan') thay vì chỉ mô tả cảm xúc/không gian thuần tuý - nhưng KHÔNG suy diễn/bịa thêm cho "
        "trường nào đang trống.\n\n"

        f"{style_rules}\n\n"

        "Nhiệm vụ - trả về DUY NHẤT 1 JSON (không thêm giải thích, không bọc bằng markdown code block) với các trường:\n"
        '- "video_description": mô tả tổng hợp cảm xúc, không gian (vibe) của khách sạn - dùng làm ngữ cảnh viết bài PR.\n'
        '- "video_summary": tóm tắt kịch bản trong 2-3 câu.\n'
        f'- "video_srt": 1 khối phụ đề SRT hợp lệ (định dạng chuẩn 00:00:00,000). '
        f"BẮT BUỘC tổng thời lượng đạt tối thiểu {duration_min} giây (tối đa {duration_max} giây) - "
        "đây là yêu cầu thật, không phải gợi ý, chỉ được phép ngắn hơn nếu toàn bộ video nguồn thật sự "
        "không đủ scene hợp lệ dù đã áp dụng đúng mục 6 bên dưới. Chữ trong SRT chính là lời thoại tĩnh/text "
        "hiển thị trên video theo đúng tone giọng đã yêu cầu. "
        "Mỗi dòng SRT ứng với đúng 1 clip trong video_edit_script và phải dài đúng bằng clip đó.\n"
        '- "video_edit_script": danh sách clip cần cắt từ các video gốc, khớp 1-1 và đúng thứ tự với từng dòng SRT, '
        'mỗi phần tử dạng {"source_video": "<tên file video gốc>", "start": "mm:ss.sss", "end": "mm:ss.sss", '
        '"vibe_note": "ghi chú cảnh (VD: HOOK, CLOUD POOL...)"}, '
        "tổng thời lượng phải khớp với video_srt.\n"
        "  MỐC THỜI GIAN - ĐỌC KỸ, ĐÂY LÀ CHỖ HAY SAI NHẤT:\n"
        '  - Mốc "start"/"end" của scene trong dữ liệu phân tích phía trên là SỐ GIÂY THẬP PHÂN, đã được dò '
        "chính xác tới từng frame bằng thuật toán phát hiện chuyển cảnh. Ví dụ: 3.437 nghĩa là giây thứ 3.437.\n"
        '  - "start"/"end" của clip phải viết dạng "mm:ss.sss" và GIỮ NGUYÊN phần thập phân của scene. '
        "Ví dụ scene start = 187.437 thì clip phải là \"03:07.437\", KHÔNG được viết \"03:07\".\n"
        "  - TUYỆT ĐỐI KHÔNG làm tròn về giây nguyên, không làm tròn lên, không làm tròn xuống, không bỏ phần "
        "thập phân cho gọn. Làm tròn dù chỉ 0.5 giây là clip sẽ dính cú chuyển cảnh và hỏng sản phẩm.\n"
        "  QUY TẮC CẮT - BẮT BUỘC, vi phạm là hỏng sản phẩm:\n"
        "  1. CHỈ DÙNG SCENE CÓ TRONG DANH SÁCH TRÊN: mọi scene có chữ/logo/watermark cháy sẵn đã bị loại từ "
        "trước, TUYỆT ĐỐI không được tự thêm lại đoạn nào ngoài danh sách. Text của ta sẽ đè lên hình, dính thêm "
        f"một lớp chữ có sẵn là hỏng sản phẩm - thà video ngắn hơn {duration_min} giây còn hơn có 1 cảnh dính chữ.\n"
        "  2. LẤY NGUYÊN VẸN 1 SCENE, KHÔNG CO, KHÔNG CẮT BỚT: Mỗi clip phải là ĐÚNG 1 scene trong dữ liệu trên. "
        'Chép Y NGUYÊN "start" và "end" của scene đó, kể cả phần thập phân. Không tự cộng trừ để co vào, không '
        "lấy một khúc giữa scene, không gộp 2 scene. Biên scene đã được dò chính xác tới từng frame nên tự nó "
        "đã nằm gọn trong 1 cú quay - mọi thao tác chỉnh thêm chỉ làm sai đi.\n"
        '  3. CHỈ CHỌN SCENE DÀI TỪ 2 GIÂY TRỞ LÊN: dùng trường "duration" của scene để lọc, bỏ qua mọi scene '
        "có duration nhỏ hơn 2 giây.\n"
        "  4. TRÁNH DÙNG 2 SCENE CẠNH NHAU TRONG 1 VIDEO (JUMP CUT): Tuyệt đối không chọn 2 scene nằm sát cạnh nhau "
        "(nối tiếp nhau liền kề) của cùng 1 video gốc để đưa vào danh sách video_edit_script. Việc này sẽ tạo ra "
        "hiệu ứng giật khung hình rất xấu. Hãy đan xen các scene cách xa nhau hoặc đan xen cảnh từ các video khác nhau.\n"
        "  5. KHÔNG 2 CLIP LIÊN TIẾP CÙNG 1 VIDEO GỐC: 2 clip đứng liền nhau trong video_edit_script (kể cả khi "
        "khác scene) TUYỆT ĐỐI không được lấy cùng 1 source_video - ghép liên tiếp cùng 1 video gốc gây cảm giác "
        "giật/nhảy hình khi render, dù là 2 scene khác nhau của cùng video đó. Nếu bắt buộc phải dùng lại cùng 1 "
        "video nhiều lần trong kịch bản, phải xen kẽ ít nhất 1 clip từ video khác ở giữa. source_video của clip "
        "thứ N tuyệt đối không được trùng source_video của clip thứ N-1.\n"
        "  6. Chỉ khi đã dùng HẾT scene trong danh sách mà vẫn không đủ "
        f"{duration_min} giây thì mới được viết ít dòng SRT hơn - không được chủ động chọn ít clip hơn mức cần "
        "thiết chỉ vì muốn kịch bản ngắn gọn, và không được vi phạm quy tắc 1-5 chỉ để lấp đủ số dòng.\n"
        '- "video_styling_guideline": Gợi ý font chữ (VD: Serif nhẹ, sans Việt thanh) và màu chữ (VD: trắng ngà ấm) phù hợp với vibe.'
    )
    
    result = _generate_json_with_retry(client, settings.gemini_synthesis_model, [prompt])

    # Prompt ở trên đã cấm làm tròn, nhưng cấm bằng lời không bảo đảm được - model vẫn trả
    # "00:26" thay vì "00:26.500". Hai bước dưới sửa lại bằng code: kéo mốc clip về đúng biên
    # scene đã dò được, rồi tính lại mốc SRT từ độ dài clip để chữ không lệch khỏi hình.
    clips = result.get("video_edit_script")
    if isinstance(clips, list) and clips:
        kept, kept_indices = scene_refiner.snap_clips_to_scenes(clips, per_video_analyses)
        result["video_edit_script"] = kept
        srt = result.get("video_srt")
        if isinstance(srt, str) and srt.strip():
            result["video_srt"] = scene_refiner.rebuild_srt(srt, kept, kept_indices)
    return result
