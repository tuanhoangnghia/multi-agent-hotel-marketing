/**
 * Rules & Skills: nơi cấu hình "linh động" các chỉ dẫn (skill) mà Claude phải tuân theo,
 * thay cho việc hard-code trong Agent2/3/4.gs. Người vận hành (không cần biết code) chỉnh
 * sửa trực tiếp trên sheet "Rules" — thêm/sửa/xoá/disable rule, thêm platform mới — mà
 * không cần sửa hay deploy lại Apps Script.
 *
 * Cấu trúc sheet "Rules" (tự tạo + seed dữ liệu mẫu nếu chưa có):
 *   scope        | target   | rule_text                              | enabled
 *   -------------|----------|-----------------------------------------|--------
 *   platform     | facebook | - Bài đăng Facebook: 80-150 từ, ...      | TRUE
 *   platform     | zalo     | - Bài Zalo: ...                          | TRUE
 *   persona      |          | (chỉ dẫn thêm khi chọn buyer persona)    | TRUE
 *   brief        |          | (chỉ dẫn thêm khi viết campaign brief)   | TRUE
 *   video_style  |          | (thay thế toàn bộ văn phong video mặc định) | TRUE
 *
 * - scope "platform": rule_text là skill viết nội dung cho 1 platform (target = tên platform,
 *   phải khớp với danh sách trong Script Property PLATFORMS). Muốn thêm platform mới: thêm
 *   platform đó vào PLATFORMS, rồi thêm 1 (hoặc nhiều) dòng scope=platform, target=<platform>.
 * - scope "persona"/"brief": rule_text là chỉ dẫn bổ sung, được nối thêm vào system prompt
 *   của Agent2 (chọn persona) / Agent3 (viết brief). target bỏ trống hoặc ghi chú tuỳ ý.
 * - scope "video_style": rule_text là văn phong/quy tắc copywriting cho video do
 *   video-agent-service (Cloud Run) sinh ra - gửi kèm trong context khi submit job qua
 *   VideoAgentClient.gs. Để trống = dùng văn phong CHV mặc định đã code sẵn bên Cloud Run;
 *   điền vào = THAY THẾ HOÀN TOÀN văn phong mặc định đó (không phải nối thêm, vì đây là 1 khối
 *   hướng dẫn văn phong đầy đủ, nối thêm dễ gây mâu thuẫn chỉ dẫn).
 * - Có thể thêm nhiều dòng cùng scope+target — tất cả dòng enabled=TRUE sẽ được nối lại
 *   (theo đúng thứ tự trên sheet) thành 1 khối chỉ dẫn.
 * - enabled: để trống hoặc TRUE = áp dụng; FALSE = tạm tắt rule mà không cần xoá dòng.
 */

var RULES_HEADERS_ = ['scope', 'target', 'rule_text', 'enabled'];

var DEFAULT_RULES_SEED_ = [
  ['platform', 'facebook', [
    '- Bài Facebook PHẢI theo ĐÚNG khung cấu trúc dưới đây (đây là format khách hàng CHV đang dùng thật - viết đủ các phần theo đúng thứ tự, linh hoạt số câu/cách diễn đạt trong từng phần chứ KHÔNG phải điền cứng như Zalo):',
    '',
    '1. HOOK (mở đầu, IN HOA TOÀN BỘ hoặc gần như toàn bộ): 1 câu tiêu đề chạm insight/cảm xúc, không nhắc tên khách sạn, không liệt kê tiện ích. Ngay sau đó có thể thêm 2-4 dòng ngắn (mỗi dòng 1 ý, không viết hoa) khắc hoạ cụ thể CẢM GIÁC của kỳ nghỉ (VD: "Thức dậy không cần báo thức.", "Nghe tiếng biển nhiều hơn tiếng điện thoại."). Có thể kèm 1 emoji cuối dòng tiêu đề.',
    '2. CÂU DẪN VÀO KHÁCH SẠN: 1 câu văn tự nhiên gắn tình huống/nhu cầu khách với tên khách sạn, mẫu câu gợi ý: "Nếu đang [dự tính/tìm/tính] [chuyến đi/resort] [ở đâu đó/cho dịp gì], CHV gợi ý [Tên khách sạn]." (có thể thêm emoji địa danh trước tên khách sạn thay cho câu dẫn nếu phù hợp).',
    '3. MÔ TẢ KHÔNG GIAN (1-2 câu, tuỳ chọn): hình ảnh cụ thể, giàu chi tiết (VD: "villa bên biển", "hồ bơi trải dài về phía chân trời") - không dùng tính từ chung chung ("tuyệt đẹp", "sang trọng").',
    '4. KHỐI GIÁ/TIỆN ÍCH: mỗi ý 1 dòng riêng, có emoji đầu dòng, dùng emoji nhất quán: 💰 hoặc ✨ cho dòng giá ("Giá [ưu đãi] CHV từ [giá]/đêm" hoặc "/phòng/đêm"), 🍽 cho dòng "Bao gồm ăn sáng + thuế phí" (hoặc "& thuế phí" / ", thuế & phí" - tuỳ biến nhẹ được), 📅 cho dòng "Áp dụng [lưu trú] [khoảng ngày]". Có thể thêm 1-2 dòng tiện ích/loại hình nổi bật khác (VD: 🏨 loại hình resort, 🌿 không gian) nếu có dữ liệu phù hợp.',
    '5. GHI CHÚ ĐIỀU KIỆN ĐẶC BIỆT (tuỳ chọn, 1 câu ngắn đứng riêng dòng ngay sau khối giá): VD "Cuối tuần có phụ thu.", "Điểm đáng chú ý là mức giá này chỉ mở bán đến [ngày]."',
    '6. ĐOẠN CẢM XÚC/INSIGHT ĐÓNG BÀI (1-3 câu): quay lại giọng văn cảm xúc như phần Hook - hướng tới đối tượng cụ thể (honeymoon/gia đình/nhóm bạn) hoặc 1 insight khép lại (VD: "Đi [địa danh] đôi khi không cần một lịch trình thật dài. Chỉ cần chọn được một nơi đủ đẹp để mình muốn ở lại lâu hơn một chút.").',
    '7. CTA: bắt đầu bằng "📩 Inbox CHV" (hoặc "CHV Travel"), luôn yêu cầu khách cung cấp "ngày đi/lưu trú + số khách" (có thể thêm "+ số phòng"), kết bằng cụm mô tả việc CHV sẽ làm ("để kiểm tra ưu đãi." / "team kiểm tra hạng phòng và ưu đãi phù hợp tại thời điểm đặt nha." / "đội ngũ CHV sẽ kiểm tra hạng phòng và mức giá tốt nhất tại thời điểm đặt."). KHÔNG cố định nguyên văn như Zalo, nhưng LUÔN bắt đầu bằng "📩 Inbox CHV".',
    '8. SIGN-OFF: dòng riêng "CHV TRAVEL" (viết hoa), có thể kèm ngay sau 1 câu tagline/triết lý thương hiệu ngắn (VD: "Có những chuyến đi không cần đi thật nhiều. Chỉ cần ở đúng nơi.").',
    '9. HASHTAG (dòng cuối cùng): luôn bắt đầu bằng "#CHVTravel", theo sau là "#[TênKháchSạnViếtLiềnKhôngDấuKhôngCách]" và "#[TênĐịaDanh]", có thể thêm 1 hashtag chủ đề (VD: "#NghiDuong5Sao").',
    '',
    'NGUYÊN TẮC GIỌNG VĂN xuyên suốt Hook/Mô tả/Đoạn đóng bài (không áp dụng cho khối Giá/tiện ích - phần đó cần rõ ràng, thông tin):',
    '- CHV Travel bán TOUR/KỲ NGHỈ, khách sạn chỉ là bối cảnh - viết để khách MUỐN CÓ kỳ nghỉ đó, không phải để khách biết khách sạn có gì.',
    '- Sang nhưng không sáo rỗng; có cảm xúc nhưng phải bán được hàng (chốt được inbox, không chỉ "đẹp lời").',
    '- Tránh mỹ từ quảng cáo đại trà ("tuyệt vời", "đẳng cấp", "hoàn hảo"...) nếu không đi kèm chi tiết/hình ảnh cụ thể.',
    '- Ưu tiên 1 insight/cảm giác trọng tâm khách sẽ nhận được thay vì liệt kê nhiều tiện ích/USP cùng lúc (tiện ích cụ thể để dành cho khối Giá/tiện ích ở phần 4).',
    '- Câu ngắn, dễ đọc, xuống dòng hợp lý.',
    '',
    'QUY TẮC khi dữ liệu đầu vào bị thiếu (không được tự bịa số liệu/ngày tháng, áp dụng cùng logic đã thống nhất ở rule Zalo):',
    '- "📅 Áp dụng" (nguồn: giai_doan) - video không thể xác nhận mốc giá. Nếu giai_doan trống, BỎ HẲN dòng "📅", không suy diễn từ video, không tự đặt ngày.',
    '- Khối "Giá/tiện ích" (nguồn ưu tiên: benefits_raw cho các dòng tiện ích, gia cho dòng giá) - liệt kê nguyên ý đã có, không tự thêm/bớt.',
    '  + Nếu benefits_raw TRỐNG nhưng có dữ liệu video (video_edit_script/video_description): có thể thêm 1-2 dòng tiện ích quan sát được từ video vào khối này, nhưng PHẢI diễn đạt như tiện ích/không gian quan sát được (VD: "🌿 Không gian nhiều cây xanh") - KHÔNG diễn đạt như quyền lợi tặng kèm/miễn phí trong giá.',
    '  + Nếu benefits_raw trống và không có dữ liệu video dùng được: bỏ các dòng tiện ích đó, chỉ giữ dòng giá (💰/✨) và dòng ăn sáng (🍽, chỉ khi có dữ liệu tương ứng).',
    '- "Ghi chú điều kiện đặc biệt" (nguồn: booking_note) - không có tương đương trong video, KHÔNG suy diễn. Nếu booking_note trống, bỏ hẳn phần 5, không thay bằng nội dung video.',
    '- Hashtag tên khách sạn/địa danh: nếu thiếu destination, chỉ dùng #CHVTravel + tên khách sạn viết liền, bỏ hashtag địa danh.',
  ].join('\n'), true],
  ['platform', 'zalo', [
    '- Bài Zalo PHẢI theo ĐÚNG template cố định dưới đây (đây là format khách hàng CHV đang dùng thật - tuân thủ nguyên cấu trúc, KHÔNG viết văn xuôi tự do, KHÔNG đổi thứ tự, KHÔNG thêm/bớt dòng trống):',
    '',
    '🔥 [TÊN KHÁCH SẠN VIẾT HOA TOÀN BỘ]',
    '',
    '💰 Giá từ: [giá]',
    '📅 Áp dụng: [khoảng thời gian áp dụng]',
    '🎁 Quyền lợi: [dòng quyền lợi đầu tiên]',
    '[các dòng quyền lợi tiếp theo, mỗi quyền lợi 1 dòng riêng, KHÔNG lặp lại nhãn "🎁 Quyền lợi:" ở các dòng sau]',
    '',
    '📌 [Ghi chú/điều kiện đặc biệt nếu có, ví dụ: mùa cao điểm, phụ thu cuối tuần/lễ]',
    '',
    '📩 Nhắn CHV ngày dự kiến đi để kiểm tra giá và tình trạng phòng.',
    '',
    '- Dòng CTA cuối cùng LUÔN LUÔN giữ NGUYÊN VĂN y hệt: "📩 Nhắn CHV ngày dự kiến đi để kiểm tra giá và tình trạng phòng." - tuyệt đối không paraphrase, không đổi 1 chữ nào.',
    '- Tên khách sạn viết HOA TOÀN BỘ, chỉ có 1 dòng, không thêm mô tả/tính từ.',
    '',
    'QUY TẮC RIÊNG cho từng dòng khi dữ liệu đầu vào bị thiếu (không được tự bịa số liệu/ngày tháng):',
    '- "📅 Áp dụng" (nguồn: giai_doan) - đây là mốc thời gian áp dụng GIÁ, video không thể xác nhận được. Nếu giai_doan trống, BỎ HẲN dòng "📅" luôn, không suy diễn từ video, không được tự đặt ngày.',
    '- "🎁 Quyền lợi" (nguồn ưu tiên: benefits_raw) - liệt kê nguyên các ý đã có trong benefits_raw, mỗi ý xuống 1 dòng riêng, không viết lại thành văn xuôi hoa mỹ, không tự thêm ý không có trong dữ liệu, không tự bớt ý.',
    '  + Nếu benefits_raw TRỐNG nhưng có dữ liệu video (video_edit_script/video_description): đổi nhãn dòng đó thành "🎁 Tiện ích nổi bật" (KHÔNG dùng chữ "Quyền lợi" nữa - vì đây chỉ là tiện ích quan sát được trong video, không phải cam kết tặng kèm miễn phí trong giá). Chọn lọc 2-4 tiện ích/không gian rõ ràng nhất được nhắc tới trong video_edit_script (bỏ qua các nhãn dàn dựng kỹ thuật như HOOK/CTA/SALES/REST, chỉ lấy phần mô tả tiện ích thật, VD từ "HOOK - Flycam toàn cảnh villa" chỉ lấy ý "villa", bỏ chữ HOOK) hoặc video_description, mỗi ý 1 dòng, chỉ mô tả những gì quan sát được, KHÔNG khẳng định là được tặng/miễn phí/bao gồm trong giá.',
    '  + Nếu benefits_raw trống VÀ cũng không có dữ liệu video nào dùng được: BỎ HẲN dòng "🎁" luôn.',
    '- "📌 Ghi chú" (nguồn: booking_note) - là điều kiện/phụ thu về GIÁ, video không có thông tin tương đương nên KHÔNG được suy diễn từ video trong bất kỳ trường hợp nào. Nếu booking_note trống, BỎ HẲN dòng "📌" (kể cả 2 dòng trống quanh nó), không để dòng 📌 trống, không thay bằng nội dung video.',
    '- Không thêm hashtag, không thêm emoji ngoài đúng các emoji cố định trong template (🔥💰📅🎁📌📩).',
    '- Không thêm câu mở đầu/kết thúc nào khác ngoài template - đây là format điền dữ liệu vào khung có sẵn, không phải bài viết sáng tạo tự do.',
  ].join('\n'), true],
  ['persona', '', [
    '- CHV Travel bán TOUR/KỲ NGHỈ dùng khách sạn làm bối cảnh, không phải đơn thuần khách ở khách sạn - ưu tiên chọn persona theo góc nhìn "khách đang cần loại kỳ nghỉ/cảm giác gì" (VD: cần chữa lành sau công việc căng thẳng, muốn sống chậm lại, muốn có kỷ niệm đẹp bên người thương) hơn là phân loại nhân khẩu học thuần tuý (công tác/gia đình/cặp đôi).',
    '- Nếu có video_description/video_summary (mô tả tổng hợp từ video khách sạn), ưu tiên chọn persona khớp với cảm giác/insight mà video toát lên, thay vì chỉ dựa loại phòng hay tiện ích liệt kê.',
  ].join('\n'), true],
  ['brief', '', [
    '- Brief phải phản ánh đúng tinh thần CHV: bán CẢM GIÁC của kỳ nghỉ, không bán khách sạn. Thông điệp chính (key message) nên xoay quanh 1 insight/cảm giác trọng tâm, không liệt kê nhiều USP cùng lúc.',
    '- Tránh đề xuất selling points kiểu liệt kê tiện ích (hồ bơi, phòng gym, buffet...) - ưu tiên selling points là cảm giác/trải nghiệm khách nhận được.',
    '- Tone & giọng văn đề xuất cần nhất quán "sang nhưng không sáo rỗng, có cảm xúc nhưng phải bán được hàng" - tránh đề xuất tone kiểu quảng cáo đại trà.',
  ].join('\n'), true],
  ['video_style', '', [
    'NGUYÊN TẮC QUAN TRỌNG NHẤT - chi phối MỌI quyết định viết, ưu tiên cao hơn tất cả các quy tắc khác:',
    '"Không làm video để giới thiệu khách sạn. Làm video để khiến khách muốn có kỳ nghỉ đó."',
    'Khách sạn chỉ là bối cảnh - nhân vật chính là CẢM GIÁC khách sẽ có trong kỳ nghỉ đó (được nghỉ ngơi thật sự, được sống chậm lại, được ở bên người mình thương, được là chính mình). Trước khi viết mỗi câu, tự hỏi: "câu này khiến khách sạn nghe hay hơn, hay khiến khách MUỐN CÓ kỳ nghỉ này hơn?" - nếu chỉ làm vế đầu thì viết lại.',
    '',
    'PHONG CÁCH CHV (bắt buộc tuân thủ toàn bộ, không được vi phạm dù chỉ 1 điểm):',
    '1. Sang nhưng không sáo rỗng - sang trọng đến từ sự tiết chế và chọn lọc chi tiết, không phải từ tính từ to tát.',
    '2. Có cảm xúc nhưng phải bán được hàng - mỗi câu chạm cảm xúc đều phải dẫn khách gần hơn tới quyết định đặt chỗ, không cảm xúc suông, không thơ hoá vô nghĩa.',
    '3. Ngắn, dễ đọc - câu ngắn, không câu phức, không giải thích dài dòng.',
    "4. Không viết kiểu brochure khách sạn - tuyệt đối không liệt kê tiện ích ('5 sao', 'all inclusive', 'hồ bơi vô cực'), không kể tính năng phòng.",
    '5. Không nhồi quá nhiều USP - chọn ĐÚNG 1 cảm giác chủ đạo xuyên suốt cả kịch bản, không cố nhét hết mọi điểm mạnh của khách sạn vào.',
    '6. Tránh câu chữ quảng cáo đại trà - CẤM DÙNG các cụm đã bị lạm dụng tới mức vô nghĩa: "thiên đường nghỉ dưỡng", "đẳng cấp 5 sao", "sang trọng bậc nhất", "trải nghiệm khó quên/tuyệt vời", "không gian xanh mát trong lành", "dịch vụ đẳng cấp quốc tế", "tọa lạc tại vị trí đắc địa", "quý khách", "trải nghiệm đẳng cấp", "thế giới riêng", "chốn bình yên" - nếu định dùng cụm nào nghe quen tai như quảng cáo đại trà, hãy viết lại theo cách cụ thể/riêng của khách sạn này.',
    '7. Ưu tiên insight và cảm giác khách hàng nhận được hơn là sự thật về khách sạn - insight trả lời câu hỏi "khách đang thiếu gì trong nhịp sống hiện tại mà kỳ nghỉ này bù đắp được", không phải "khách sạn có gì".',
    '',
    'CÁC QUY TẮC BỔ SUNG:',
    '- TONE GIỌNG: Sang trọng, tĩnh lặng nhưng thủ thỉ như người quen, không phải giọng MC quảng cáo.',
    "- CTA NHẸ NHÀNG (Phần cuối): Chỉ để Tên thương hiệu + Tên Đại lý (Ví dụ: CHV TRAVEL - Inbox để chọn ngày đẹp). BỎ hotline, BỎ chữ 'đặt ngay'.",
    '- KHÔNG EMOJI: Sang trọng là sự kìm nén. Ngôn từ súc tích, ngắn gọn.',
    '',
    'THAM KHẢO CẤU TRÚC KỊCH BẢN (Hãy linh hoạt áp dụng theo dữ liệu khách sạn nhưng giữ tinh thần này):',
    "0-3s [HOOK] Cảnh mở cực rộng (ví dụ: thiên nhiên hùng vĩ) -> Text: 'CÓ NHỮNG NƠI, CHỈ CẦN ĐẾN LÀ MUỐN Ở LẠI.'",
    "3-7s [ĐIỂM CHẠM 1] Cảnh tiêu biểu -> Text: 'Bơi giữa một thung lũng đầy mây'",
    "7-11s [ĐIỂM CHẠM 2] -> Text: 'Thức dậy giữa màu xanh...'",
    "11-15s [ĐIỂM CHẠM 3] -> Text: 'Đi thật chậm. Nghe rừng nhiều hơn.'",
    "15-19s [KHOẢNH KHẮC] Cảnh nghỉ ngơi tĩnh lặng -> Text: 'Và chẳng cần vội đi đâu cả.'",
    "19-23s [SALES] Cảnh hero đẹp nhất -> Text: '[Tên Khách Sạn]\\nTừ [Giá] triệu/đêm\\n[Tên Đại Lý]\\nInbox [Tên Đại Lý] để chọn ngày đẹp'",
  ].join('\n'), true],
];

function getRulesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(getRulesSheetName_());
  if (!sheet) {
    sheet = ss.insertSheet(getRulesSheetName_());
    sheet.getRange(1, 1, 1, RULES_HEADERS_.length).setValues([RULES_HEADERS_]);
    sheet.getRange(2, 1, DEFAULT_RULES_SEED_.length, RULES_HEADERS_.length).setValues(DEFAULT_RULES_SEED_);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, RULES_HEADERS_.length);
  }
  return sheet;
}

function openRulesSheet_() {
  var sheet = getRulesSheet_();
  SpreadsheetApp.setActiveSheet(sheet);
}

// Đọc + gộp rule từ sheet "Rules" thành 1 object dùng trong suốt 1 lần chạy pipeline.
// { platform: { facebook: "...", zalo: "..." }, persona: "...", brief: "..." }
function loadRules_() {
  var sheet = getRulesSheet_();
  var values = sheet.getDataRange().getValues();

  var rules = { platform: {}, persona: '', brief: '', video_style: '' };
  if (values.length < 2) {
    return rules;
  }

  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var colScope = headers.indexOf('scope');
  var colTarget = headers.indexOf('target');
  var colText = headers.indexOf('rule_text');
  var colEnabled = headers.indexOf('enabled');

  if (colScope === -1 || colText === -1) {
    return rules; // sheet bị sửa sai cấu trúc header -> bỏ qua, dùng default rỗng
  }

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var scope = String(row[colScope] || '').trim().toLowerCase();
    var target = colTarget === -1 ? '' : String(row[colTarget] || '').trim().toLowerCase();
    var text = colText === -1 ? '' : String(row[colText] || '').trim();
    var enabledRaw = colEnabled === -1 ? true : row[colEnabled];
    var enabled = enabledRaw === '' || enabledRaw === null || enabledRaw === undefined
      ? true
      : (enabledRaw === true || String(enabledRaw).trim().toUpperCase() === 'TRUE');

    if (!scope || !text || !enabled) {
      continue;
    }

    if (scope === 'platform' && target) {
      rules.platform[target] = rules.platform[target] ? rules.platform[target] + '\n' + text : text;
    } else if (scope === 'persona') {
      rules.persona = rules.persona ? rules.persona + '\n' + text : text;
    } else if (scope === 'brief') {
      rules.brief = rules.brief ? rules.brief + '\n' + text : text;
    } else if (scope === 'video_style') {
      rules.video_style = rules.video_style ? rules.video_style + '\n' + text : text;
    }
  }

  return rules;
}

// Cache trong phạm vi 1 lần chạy script (Apps Script không giữ state giữa các lần chạy khác nhau).
var rulesCache_ = null;

function getRulesCached_() {
  if (!rulesCache_) {
    rulesCache_ = loadRules_();
  }
  return rulesCache_;
}

function resetRulesCache_() {
  rulesCache_ = null;
}

function getPlatformSkill_(platform) {
  var rules = getRulesCached_();
  return rules.platform[platform]
    || '- Viết nội dung phù hợp với nền tảng ' + platform + '.';
}

function getPersonaExtraRules_() {
  return getRulesCached_().persona;
}

function getBriefExtraRules_() {
  return getRulesCached_().brief;
}

// Trả về '' nếu chưa cấu hình - VideoAgentClient.gs (khi được code) chỉ gửi field này trong
// context nếu có giá trị, để Cloud Run tự dùng văn phong mặc định của nó khi rỗng.
function getVideoStyleRules_() {
  return getRulesCached_().video_style;
}
