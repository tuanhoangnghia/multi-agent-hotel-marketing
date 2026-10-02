/**
 * Agent 2: chọn buyer persona phù hợp cho từng khách sạn.
 */

function selectBuyerPersona_(hotel) {
  var systemPrompt =
    'Bạn là chuyên gia phân khúc khách hàng (buyer persona) cho ngành khách sạn/du lịch. ' +
    'Chỉ trả về JSON hợp lệ, không thêm chữ nào khác ngoài JSON.';

  var extraRules = getPersonaExtraRules_();
  if (extraRules) {
    systemPrompt += '\n\nQuy tắc bổ sung (do người vận hành cấu hình trong sheet Rules):\n' + extraRules;
  }

  var userPrompt = [
    'Dựa trên thông tin khách sạn dưới đây, hãy chọn 1 buyer persona phù hợp nhất để nhắm mục tiêu marketing.',
    '',
    buildHotelContextText_(hotel),
    '',
    'Trả về đúng JSON theo format sau (không markdown, không giải thích thêm):',
    '{"persona": "<tên persona ngắn, ví dụ: Doanh nhân công tác, Gia đình du lịch, Cặp đôi hưởng trăng mật, Backpacker tiết kiệm, Nhóm bạn trẻ>", "reason": "<1-2 câu giải thích vì sao chọn persona này>", "tone": "<gợi ý tone giọng văn, ví dụ: sang trọng, gần gũi, năng động>"}',
  ].join('\n');

  var raw = callClaude_(systemPrompt, userPrompt, 300);
  return extractJson_(raw);
}
